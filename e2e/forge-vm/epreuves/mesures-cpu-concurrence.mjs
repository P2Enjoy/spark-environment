/**
 * Mesure sur la VM du banc : la réservation CPU (le poids) garde-t-elle son effet
 * sous contention quand un plafond est posé ?
 *
 * @verifies docs/BACKLOG.md#SPK-145 · docs/EXPLORATION_QUOTAS.md (le poids sous
 *           contention, avec et sans plafond) · docs/DAT.md §7.2, §7.3
 *
 * Deux cellules jetables, lancées par `incus` hors du registre, ÉPINGLÉES sur le
 * même cœur (`limits.cpu=0-0` — `0` seul est refusé par Incus, mesuré) : chacune
 * y fait tourner une boucle occupée, et le cœur ne suffit pas aux deux. C'est la
 * contention, et c'est là seulement qu'un poids dit quelque chose. On lit la part
 * de chacune dans son `cpu.stat`, côté Forge, dans UN script, sur la même
 * fenêtre, rapportée au temps réellement écoulé.
 *
 * Ce n'est pas une épreuve du produit : elle ne juge rien, elle relève, et le
 * responsable décide (SPK-145).
 */

const A = 'concurrence-a';
const B = 'concurrence-b';
const cg = (c) => `/sys/fs/cgroup/lxc.payload.${c}`;

export default async function jouer({ ssh, dire, verdict }) {
  const sh = (commande) => ssh(commande, { tolerer: true, delai: 300 });
  const poser = (c, cle, valeur) => {
    const r = sh(valeur === null ? `sudo incus config unset ${c} ${cle} 2>&1`
      : `sudo incus config set ${c} '${cle}=${valeur}' 2>&1`);
    dire(`POSE ${c} ${cle}=${valeur} → code ${r.code}${r.sortie ? ` : ${r.sortie.slice(0, 300)}` : ''}`);
  };
  const redemarrer = (c) => dire(`REDÉMARRAGE ${c} → ${sh(`sudo incus restart ${c} 2>&1`).code}`);
  const reglages = (c) => sh(`sudo cat ${cg(c)}/cpu.weight ${cg(c)}/cpu.max`).sortie
    .split('\n');
  /** Les deux boucles, la même fenêtre, la part de chacune en CPU. Le script vit
   *  sur la VM : les deux relevés y sont pris l'un après l'autre, sans aller-retour
   *  SSH entre eux, et rapportés au temps réellement écoulé. */
  const disputer = (titre) => {
    const brut = sh(`sudo sh /tmp/concurrence.sh ${A} ${B}`).sortie.trim().split(/\s+/).map(Number);
    const [a0, a1, b0, b1, t0, t1] = brut;
    const ecoule = (t1 - t0) / 1000;                       // ns → µs
    const [ra, rb] = [reglages(A), reglages(B)];
    const r = { a: ((a1 - a0) / ecoule).toFixed(2), b: ((b1 - b0) / ecoule).toFixed(2),
                a_poids: ra[0], a_max: ra[1], b_poids: rb[0], b_max: rb[1],
                cpuset_a: sh(`sudo cat ${cg(A)}/cpuset.cpus.effective`).sortie,
                cpuset_b: sh(`sudo cat ${cg(B)}/cpuset.cpus.effective`).sortie };
    dire(`CONCURRENCE ${titre} : ${JSON.stringify(r)}`);
    return r;
  };

  try {
    sh(`cat > /tmp/concurrence.sh <<'EOS'
A=$1; B=$2
for c in $A $B; do incus exec $c -- sh -c '(while :; do :; done) >/dev/null 2>&1 &'; done
sleep 2
u() { grep '^usage_usec' /sys/fs/cgroup/lxc.payload.$1/cpu.stat | cut -d' ' -f2; }
t0=$(date +%s%N); a0=$(u $A); b0=$(u $B)
sleep 6
t1=$(date +%s%N); a1=$(u $A); b1=$(u $B)
for c in $A $B; do incus exec $c -- pkill -f 'while :'; done
echo "$a0 $a1 $b0 $b1 $t0 $t1"
EOS`);
    for (const c of [A, B]) {
      const lance = sh(`sudo incus launch images:ubuntu/24.04 ${c} -s spark 2>&1`);
      if (lance.code !== 0) throw new Error(`incus launch ${c} : ${lance.sortie.slice(-300)}`);
      poser(c, 'limits.cpu', '0-0');
    }
    // 1. Deux poids seuls : 75 contre 25.
    poser(A, 'limits.cpu.allowance', '75%');
    poser(B, 'limits.cpu.allowance', '25%');
    disputer('poids 75 / 25, sans plafond');
    // 2. Le plus lourd reçoit un plafond SOUS sa part : le plafond gagne, et le
    //    reste revient à l'autre.
    poser(A, 'raw.lxc', 'lxc.cgroup2.cpu.max=50000 100000');
    redemarrer(A);
    disputer('poids 75 + plafond 0,5 / poids 25');
    // 3. Le plus LÉGER reçoit un plafond AU-DESSUS de sa part : c'est le poids
    //    qui doit décider, si le plafond n'éteint pas la réservation.
    poser(A, 'raw.lxc', null);
    redemarrer(A);
    poser(A, 'limits.cpu.allowance', '25%');
    poser(B, 'limits.cpu.allowance', '75%');
    poser(A, 'raw.lxc', 'lxc.cgroup2.cpu.max=60000 100000');
    redemarrer(A);
    disputer('poids 25 + plafond 0,6 / poids 75');
    verdict('SPK-145 : la mesure est allée au bout', true, 'relevés ci-dessus, lignes CONCURRENCE');
  } finally {
    sh(`sudo incus delete -f ${A} ${B} 2>&1`);
  }
}
