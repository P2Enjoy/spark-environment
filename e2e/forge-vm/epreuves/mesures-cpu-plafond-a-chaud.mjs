/**
 * Mesure sur la VM du banc : un plafond CPU écrit EN DIRECT dans le cgroup d'une
 * cellule du produit s'applique-t-il sans redémarrer, et qu'est-ce qui l'écrase ?
 *
 * @verifies docs/BACKLOG.md#SPK-152 · docs/EXPLORATION_QUOTAS.md (le plafond à
 *           chaud, dans la tranche) · docs/DAT.md §7.2, §32.1
 *
 * Arbitré le 2026-10-06 : avant de décider comment un nouveau plafond prend effet
 * dans le mode « partagé plafonné », mesurer. La cellule est le Spark « temoin »
 * du banc — une cellule du PRODUIT, rangée par son `raw.lxc` dans
 * `spark.slice` (§32.1), en mode partagé. Ce n'est pas une épreuve du produit :
 * elle relève, le responsable décide.
 */

const SPARK = 'temoin';
const CG = `/sys/fs/cgroup/spark.slice/${SPARK}`;

export default async function jouer({ ssh, dire, verdict }) {
  const sh = (commande) => ssh(commande, { tolerer: true, delai: 300 });
  const reglages = () => sh(`sudo cat ${CG}/cpu.weight ${CG}/cpu.max`).sortie.split('\n');
  /** La part prise par deux boucles occupées, sur 6 s, rapportée au temps écoulé. */
  const charge = () => {
    const r = sh(`sudo sh -c 'incus exec ${SPARK} -- sh -c "(while :; do :; done) >/dev/null 2>&1 & `
      + `(while :; do :; done) >/dev/null 2>&1 &"; sleep 2; `
      + `t0=$(date +%s%N); a0=$(grep "^usage_usec" ${CG}/cpu.stat | cut -d" " -f2); sleep 6; `
      + `t1=$(date +%s%N); a1=$(grep "^usage_usec" ${CG}/cpu.stat | cut -d" " -f2); `
      + `incus exec ${SPARK} -- pkill -f "while :"; echo $a0 $a1 $t0 $t1'`).sortie;
    const [a0, a1, t0, t1] = r.trim().split(/\s+/).map(Number);
    return `${((a1 - a0) / ((t1 - t0) / 1000)).toFixed(2)} CPU`;
  };
  const relever = (titre) => {
    const [poids, max] = reglages();
    dire(`PLAFOND ${titre} : ${JSON.stringify({ poids, max, charge: charge() })}`);
  };

  const existe = sh(`sudo test -d ${CG} && echo oui`).sortie;
  if (existe !== 'oui') throw new Error(`cgroup introuvable : ${CG}`);
  relever('départ (mode partagé, aucun plafond)');

  // 1. Le plafond écrit en direct, cellule en marche.
  dire(`ÉCRITURE ${CG}/cpu.max ← 50000 100000 → code ${
    sh(`sudo sh -c 'echo "50000 100000" > ${CG}/cpu.max'`).code}`);
  relever('plafond 0,5 écrit en direct');

  // 2. Un geste ordinaire du produit sur la même cellule : une nouvelle
  //    réservation, posée à chaud par Incus. Écrase-t-elle le plafond ?
  dire(`POSE limits.cpu.allowance=40% → code ${
    sh(`sudo incus config set ${SPARK} limits.cpu.allowance=40% 2>&1`).code}`);
  relever('après une nouvelle réservation posée par Incus');

  // 3. Le plafond par raw.lxc, ajouté aux lignes de la tranche, puis un
  //    redémarrage : tient-il DANS la tranche ?
  const brut = sh(`sudo incus config get ${SPARK} raw.lxc`).sortie;
  dire(`RAW.LXC actuel : ${JSON.stringify(brut)}`);
  const avecPlafond = `${brut.trimEnd()}\nlxc.cgroup2.cpu.max = 50000 100000\n`;
  const pose = sh(`sudo incus config set ${SPARK} raw.lxc="$(printf '%b' ${JSON.stringify(avecPlafond)
    .replace(/'/g, "'\\''")})" 2>&1`);
  dire(`POSE raw.lxc + plafond → code ${pose.code}${pose.sortie ? ` : ${pose.sortie.slice(0, 300)}` : ''}`);
  dire(`REDÉMARRAGE → ${sh(`sudo incus restart ${SPARK} 2>&1`).code}`);
  relever('plafond par raw.lxc, après redémarrage, dans la tranche');

  // 4. Le plafond retiré à chaud, pour rendre la cellule au banc.
  sh(`sudo sh -c 'echo "max 100000" > ${CG}/cpu.max'`);
  sh(`sudo incus config set ${SPARK} raw.lxc="$(printf '%b' ${JSON.stringify(brut)
    .replace(/'/g, "'\\''")})" 2>&1`);
  verdict('SPK-152 : la mesure du plafond à chaud est allée au bout', true,
          'relevés ci-dessus, lignes PLAFOND');
}
