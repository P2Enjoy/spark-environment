/**
 * Mesure sur la VM du banc : le CPU et la mémoire peuvent-ils porter une
 * réservation ET un plafond sur une même cellule ?
 *
 * @verifies docs/BACKLOG.md#SPK-143 · docs/EXPLORATION_QUOTAS.md (ce qui est
 *           mesuré, et comment) · docs/DAT.md §7.2, §7.6
 *
 * Ce n'est pas une épreuve du PRODUIT : c'est une mesure des primitives d'Incus,
 * sur une cellule jetable lancée directement par `incus`, hors du registre. Elle
 * ne juge rien — elle relève ce que le noyau pose, et ce que la cellule subit, et
 * le consigne pour que le responsable décide (SPK-143).
 */
// Aucun navigateur ici : la mesure passe par SSH, dans le processus du banc qui
// tient déjà le verrou des épreuves lourdes.

const C = 'mesure-quotas';
const CG = `/sys/fs/cgroup/lxc.payload.${C}`;

export default async function jouer({ ssh, dire, verdict }) {
  const sh = (commande) => ssh(commande, { tolerer: true, delai: 300 });
  const lire = (fichiers) => Object.fromEntries(fichiers.map((f) =>
    [f, sh(`sudo cat ${CG}/${f} 2>&1`).sortie]));
  const relever = (titre, fichiers) => {
    const valeurs = lire(fichiers);
    dire(`MESURE ${titre} : ${JSON.stringify(valeurs)}`);
    return valeurs;
  };
  const poser = (cles, { redemarrer = false } = {}) => {
    for (const [cle, valeur] of Object.entries(cles)) {
      // La syntaxe `clé=valeur`, entre apostrophes : l'ancienne, `clé valeur`,
      // se trompe sur une valeur qui contient elle-même un `=` — mesuré.
      const r = sh(valeur === null ? `sudo incus config unset ${C} ${cle} 2>&1`
        : `sudo incus config set ${C} '${cle}=${valeur}' 2>&1`);
      dire(`POSE ${cle}=${valeur} → code ${r.code}${r.sortie ? ` : ${r.sortie.slice(0, 600)}` : ''}`);
    }
    if (redemarrer) dire(`REDÉMARRAGE → ${sh(`sudo incus restart ${C} 2>&1`).code}`);
  };
  /** CPU consommé, en CPU, par deux boucles occupées pendant 5 s. */
  const chargeCpu = () => {
    // Deux boucles, tuées par leur PID : une boucle orpheline fausserait la
    // mesure suivante.
    const sortie = sh(`sudo incus exec ${C} -- sh -c '(while :; do :; done) >/dev/null 2>&1 & p1=$!; `
      + `(while :; do :; done) >/dev/null 2>&1 & p2=$!; sleep 1; `
      + `a=$(grep usage_usec /sys/fs/cgroup/cpu.stat | cut -d" " -f2); sleep 5; `
      + `b=$(grep usage_usec /sys/fs/cgroup/cpu.stat | cut -d" " -f2); kill $p1 $p2; `
      + `echo $(( (b - a) / 50000 ))'`).sortie;
    return `${Number(sortie) / 100} CPU`;
  };
  /** Ce que la cellule subit en voulant 700 Mio : un tueur, un frein, ou rien.
   *  Bornée à 30 s et chronométrée : le 2026-10-01, la mémoire « souple » a
   *  freiné l'allocation au point de bloquer la mesure cinq minutes. */
  const pressionMemoire = () => {
    const r = sh(`debut=$(date +%s); sudo incus exec ${C} -- timeout 30 python3 -c `
      + `"b = bytearray(700 * 1024 * 1024); print('alloué')" 2>&1; code=$?; `
      + `echo code=$code en $(( $(date +%s) - debut )) s; sudo cat ${CG}/memory.events`);
    return r.sortie.replace(/\s+/g, ' ');
  };

  try {
    dire(`lancement de la cellule jetable « ${C} »`);
    const lance = sh(`sudo incus launch images:ubuntu/24.04 ${C} -s spark 2>&1`);
    if (lance.code !== 0) throw new Error(`incus launch : ${lance.sortie.slice(-300)}`);

    // --- CPU ----------------------------------------------------------------------
    poser({ 'limits.cpu.allowance': '50%' });
    relever('CPU réservation seule (allowance 50 %)', ['cpu.weight', 'cpu.max']);
    dire(`CHARGE CPU réservation seule : ${chargeCpu()}`);
    poser({ 'limits.cpu.allowance': '50ms/100ms' });
    relever('CPU plafond seul (allowance 50ms/100ms)', ['cpu.weight', 'cpu.max']);
    dire(`CHARGE CPU plafond seul : ${chargeCpu()}`);
    // Les deux à la fois : la réservation par l'allowance en pourcentage, le
    // plafond par un réglage cgroup brut. Incus n'a pas de clé qui porte les deux.
    poser({ 'limits.cpu.allowance': '50%', 'raw.lxc': 'lxc.cgroup2.cpu.max=50000 100000' },
          { redemarrer: true });
    relever('CPU réservation + plafond brut (raw.lxc)', ['cpu.weight', 'cpu.max']);
    dire(`CHARGE CPU réservation + plafond brut : ${chargeCpu()}`);
    poser({ 'raw.lxc': null }, { redemarrer: true });

    // --- mémoire ------------------------------------------------------------------
    poser({ 'limits.memory': '512MiB', 'limits.memory.enforce': 'hard' });
    relever('MÉMOIRE dure 512 Mio', ['memory.min', 'memory.low', 'memory.high', 'memory.max']);
    dire(`PRESSION mémoire dure : ${pressionMemoire()}`);
    poser({ 'limits.memory.enforce': 'soft' });
    relever('MÉMOIRE souple 512 Mio', ['memory.min', 'memory.low', 'memory.high', 'memory.max']);
    dire(`PRESSION mémoire souple : ${pressionMemoire()}`);
    // Un seuil garanti ET un plafond : plafond dur par Incus, garantie brute.
    poser({ 'limits.memory.enforce': 'hard', 'raw.lxc': 'lxc.cgroup2.memory.low=268435456' },
          { redemarrer: true });
    relever('MÉMOIRE plafond dur + garantie brute (raw.lxc memory.low)',
            ['memory.min', 'memory.low', 'memory.high', 'memory.max']);
    dire(`PRESSION mémoire plafond dur + garantie brute : ${pressionMemoire()}`);
    verdict('SPK-143 : la mesure est allée au bout', true, 'relevés ci-dessus, lignes MESURE / CHARGE / PRESSION');
  } finally {
    sh(`sudo incus delete -f ${C} 2>&1`);
  }
}
