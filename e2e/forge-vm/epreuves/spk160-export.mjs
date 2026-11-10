/**
 * SPK-160 : mesurer l'export Incus OPTIMISÉ d'un Spark avec instantanés, son import sous
 * un autre nom, dans un pool recréé, et son envoi par parts vers un S3.
 *
 * @spec docs/BACKLOG.md#SPK-160 (étapes 1 à 8) · docs/DAT.md §67.2 (la décision de
 *       format et son seuil d'infirmation), §67.7 (l'espace de travail), §8.5, §19.1
 *       (restaurer détruit les instantanés suivants) · CLAUDE.md §15 bis
 * @verifies docs/BACKLOG.md#SPK-160 · docs/DAT.md §67.2 : (a) l'export optimisé d'un
 *       Spark à 5 instantanés pèse au plus ses données utiles plus les écarts plus 10 % ;
 *       (b) son import sous un autre nom restitue les 5 instantanés, restaurables.
 *       Le critère (c) n'est qu'INDICATIF sur une VM (disques virtuels).
 *
 * Ce n'est pas une épreuve du PRODUIT : c'est une mesure des primitives d'Incus, sur des
 * cellules jetables lancées directement par `incus`, hors du registre — comme
 * `mesures-quotas.mjs` (SPK-143). Elle ne juge que les deux seuils écrits à l'avance ; le
 * reste est RELEVÉ, pour que le responsable décide.
 *
 *   make forge-vm ARGS="--travail <dossier> --epreuve spk160-export"
 *
 * Tourne dans le processus du banc, qui tient déjà le verrou des épreuves lourdes. Elle
 * ne lit aucune variable d'environnement : le banc lui passe ses outils.
 */
import { ADMIN, demarrerMinio, jouerMc, minioVivant, retirerConteneurs } from '../../s3/minio.mjs';

const MIO = 1024 * 1024;
const D = '/var/tmp/spk160';  // côté VM ; le script distant est `${D}.sh`
const PORT_MINIO = 19095;
const MINIO_VM = 'spk160-minio-vm';
const BOTO3 = 'boto3==1.43.127';

/** La bibliothèque shell des mesures. `String.raw` : aucun `${` ici, ni de guillemet inverse. */
const LIB = String.raw`
D=/var/tmp/spk160
mkdir -p $D
cpu()  { awk '/^cpu /{print $2+$3+$4+$7+$8+$9}' /proc/stat; }
io()   { awk '$3 ~ /^vd[abc]$/ {l+=$6; e+=$10} END{print l*512, e*512}' /proc/diskstats; }
now()  { date +%s.%N; }
ws()   { du -sb /var/lib/incus/backups 2>/dev/null | cut -f1; }
# Ce que la cellule voisine subit : une boucle CPU chronométrée, puis des écritures synchrones.
voisin() {
  TIMEFORMAT=%R
  t=$( { time incus exec m160v -- awk 'BEGIN{for(i=0;i<40000000;i++);}' >/dev/null; } 2>&1 )
  w=$(incus exec m160v -- sh -c 'dd if=/dev/zero of=/root/t bs=4k count=2000 oflag=dsync 2>&1 | tail -1')
  echo "cpu_boucle_s=$t dsync=[$w]"
}
zfsinfo() { zfs list -Hp -o used,refer,usedbysnapshots spark/containers/m160 2>/dev/null | awk '{print "zfs_used="$1" zfs_refer="$2" zfs_snap="$3}'; }
# export_run NOM OPTIONS... : écrit $D/NOM.tar et imprime UNE ligne RESULT mesurée.
export_run() {
  nom=$1; shift
  out=$D/$nom.tar; rm -f $out $D/poll-$nom
  ( while :; do ws >> $D/poll-$nom; sleep 0.5; done ) & p=$!
  c0=$(cpu); i0=$(io); t0=$(now)
  incus export m160 $out "$@" > $D/exp-$nom.log 2>&1; rc=$?
  t1=$(now); c1=$(cpu); i1=$(io)
  kill $p 2>/dev/null; wait $p 2>/dev/null
  taille=$(stat -c %s $out 2>/dev/null || echo 0)
  max=$(sort -n $D/poll-$nom 2>/dev/null | tail -1)
  [ -z "$max" ] && max=0
  duree=$(awk -v a=$t0 -v b=$t1 'BEGIN{printf "%.1f", b-a}')
  cpus=$(awk -v a=$c0 -v b=$c1 'BEGIN{printf "%.1f", (b-a)/100}')
  lu=$(echo $i0 $i1 | awk '{printf "%d", ($3-$1)/1048576}')
  ecrit=$(echo $i0 $i1 | awk '{printf "%d", ($4-$2)/1048576}')
  echo "RESULT nom=$nom rc=$rc taille=$taille duree_s=$duree cpu_s=$cpus io_lu_mio=$lu io_ecrit_mio=$ecrit espace_max=$max $(zfsinfo)"
  [ $rc -ne 0 ] && echo "ERREUR $(tail -c 300 $D/exp-$nom.log | tr '\n' ' ')"
  return 0
}
`;

/** Les lignes `RESULT k=v k=v` d'une sortie, en objets (nombres quand ils en sont). */
function resultats(sortie) {
  return sortie.split('\n').filter((l) => l.startsWith('RESULT ')).map((l) => {
    const o = {};
    for (const m of l.slice(7).matchAll(/(\w+)=(\S*)/g)) o[m[1]] = /^-?\d+(\.\d+)?$/.test(m[2]) ? Number(m[2]) : m[2];
    return o;
  });
}
const mio = (octets) => `${(octets / MIO).toFixed(0)} Mio`;

export default async function jouer({ ssh, dire, verdict }) {
  const distant = (script, delai = 900) => {
    const b64 = Buffer.from(`set +e\n${script}`).toString('base64');
    // Le script est un FICHIER, et bash reçoit /dev/null sur son entrée. MESURÉ le
    // 2026-11-10 (premier essai) : `incus launch`, `snapshot create`, `storage create` et
    // `exec` LISENT leur entrée standard quand ce n'est pas un terminal — du YAML, ou un
    // flux transmis au processus. Alimenté par un tube, bash les voyait avaler la suite
    // du script (« cannot construct !!str `zfsinfo` into api.InstanceSnapshotPut »).
    return ssh(`echo ${b64} | base64 -d > ${D}.sh && sudo bash ${D}.sh < /dev/null`, { tolerer: true, delai });
  };
  const lib = (script, delai) => distant(`${LIB}\n${script}`, delai);
  const releves = [];
  const noter = (r) => {
    releves.push(r);
    dire(`MESURE export ${JSON.stringify(r)}`);
  };
  try {
    // --- 0. l'environnement, tel qu'il est ----------------------------------------------
    const env = lib(String.raw`
incus version; zfs version 2>&1 | head -2; echo "--- df"; df -h / /var/tmp | cat; echo "--- mem"; free -m | sed -n 2p
echo "--- storage.backups_volume=[$(incus config get storage.backups_volume)] backups.compression_algorithm=[$(incus config get backups.compression_algorithm)]"
echo "--- export --help"; incus export --help 2>&1 | sed -n 1,30p
echo "--- import --help"; incus import --help 2>&1 | sed -n 1,16p
echo "--- zpool"; zpool list 2>&1 | cat
apt-get install -y -q zstd >/dev/null 2>&1; echo "zstd: $(command -v zstd || echo absent)"`, 600);
    dire(`MESURE environnement :\n${env.sortie}`);

    // --- 1. les cellules jetables et leurs données --------------------------------------
    const prepare = lib(String.raw`
incus launch images:ubuntu/24.04 m160 -s spark -d root,size=8GiB 2>&1 | tail -2
incus launch images:ubuntu/24.04 m160v -s spark 2>&1 | tail -2
for i in $(seq 1 60); do incus exec m160 -- true 2>/dev/null && incus exec m160v -- true 2>/dev/null && break; sleep 2; done
incus exec m160 -- sh -c 'mkdir -p /data && dd if=/dev/urandom of=/data/base bs=1M count=2048 status=none && sync && sha256sum /data/base > /root/base0.sha'
echo "base0: $(cat /dev/null; incus exec m160 -- cat /root/base0.sha)"
echo "etat 0: $(zfsinfo)"`, 900);
    dire(`MESURE préparation :\n${prepare.sortie}`);
    const existe = lib('incus info m160 >/dev/null 2>&1 && incus info m160v >/dev/null 2>&1 && echo oui || echo non', 60);
    if (!/oui/.test(existe.sortie)) {
      verdict('les deux cellules jetables existent', false, 'voir MESURE préparation — le reste de la mesure est inutile');
      return;
    }

    // --- 2. la série : 0, 1, 3, 5 instantanés, aucune compression puis zstd --------------
    // Le voisin d'abord, au repos : la référence de ce qui suit.
    dire(`MESURE voisin au repos : ${lib('voisin', 300).sortie}`);

    for (let i = 0; i <= 5; i += 1) {
      let avant = '';
      if (i >= 1) {
        // 200 Mio de blocs NEUFS ; à l'étape 3, en plus, 200 Mio de blocs EXISTANTS réécrits
        // (l'instantané retient alors les anciens : c'est le cas qui fait grossir un instantané).
        avant = `incus exec m160 -- sh -c 'dd if=/dev/urandom of=/data/d${i} bs=1M count=200 status=none'\n`
          + (i === 3 ? "incus exec m160 -- sh -c 'dd if=/dev/urandom of=/data/base bs=1M count=200 seek=100 conv=notrunc status=none'\n" : '')
          + `incus exec m160 -- sync\nincus snapshot create m160 s${i} 2>&1 | tail -1\n`;
      }
      if (![0, 1, 3, 5].includes(i)) {
        dire(`MESURE instantané s${i} pris : ${lib(`${avant}zfsinfo`, 300).sortie}`);
        continue;
      }
      let corps = `${avant}echo "ETAT i=${i} $(zfsinfo)"\n`
        + `export_run opt-none-s${i} --optimized-storage --compression none\n`
        + `export_run opt-zstd-s${i} --optimized-storage --compression zstd\n`
        // Sans l'optimisation, chaque instantané est une copie : on ne l'éprouve qu'aux
        // étapes 1 et 3, l'espace de travail de la machine ne porterait pas la suivante.
        + ([1, 3].includes(i) ? `export_run brut-none-s${i} --compression none\n` : '');
      if (i === 5) {
        // Le voisin SUBIT l'export le plus lourd : sa boucle CPU et ses écritures synchrones
        // sont rejouées 2 s après le début, comparées à leur référence au repos.
        corps = `${avant}echo "ETAT i=5 $(zfsinfo)"\n`
          + `( sleep 2; voisin > $D/voisin-pendant.txt ) &\n`
          + `export_run opt-none-s5 --optimized-storage --compression none\nwait\n`
          + `echo "VOISIN pendant l'export : $(cat $D/voisin-pendant.txt)"\n`
          + `export_run opt-zstd-s5 --optimized-storage --compression zstd\n`;
      }
      const r = lib(corps, 2400);
      for (const l of resultats(r.sortie)) noter({ i, ...l });
      for (const x of r.sortie.split('\n').filter((l) => !l.startsWith('RESULT '))) if (x.trim()) dire(`MESURE ${x}`);
      // Un fichier de plus ne sert à rien tant qu'on ne les compare pas : on libère l'espace.
      lib(`rm -f $D/opt-*-s${i}.tar $D/brut-*-s${i}.tar`, 120);
    }

    // --- 3. l'export d'un Spark EN MARCHE, avec un écrivain, et ses témoins --------------
    const ecriture = lib(String.raw`
cat > $D/ecrivain.sh <<'EOS'
#!/bin/sh
i=0
while :; do echo $i >> /data/journal; i=$((i+1)); sync; sleep 0.2; done
EOS
chmod +x $D/ecrivain.sh
incus file push $D/ecrivain.sh m160/root/ecrivain.sh
incus exec m160 -- sh -c 'cd /data && sha256sum base d1 d2 d3 d4 d5 > /root/sums && sync'
incus exec m160 -- sh -c 'setsid /root/ecrivain.sh >/dev/null 2>&1 < /dev/null &'
sleep 1
incus exec m160 -- touch /data/avant
( sleep 3; incus exec m160 -- touch /data/pendant ) &
export_run final --optimized-storage --compression none
wait
incus exec m160 -- touch /data/apres
incus exec m160 -- pkill -f ecrivain.sh
echo "SOURCE /data: $(incus exec m160 -- ls /data | tr '\n' ' ')"
echo "SOURCE journal: $(incus exec m160 -- wc -l /data/journal)"
ls -la $D/final.tar`, 1500);
    for (const l of resultats(ecriture.sortie)) noter({ i: '5-en-ecriture', ...l });
    dire(`MESURE export d'un Spark en marche :\n${ecriture.sortie.split('\n').filter((l) => !l.startsWith('RESULT ')).join('\n')}`);

    // --- 4. l'import sous un autre nom, instantanés, restauration, témoins -----------------
    const imp = lib(String.raw`
t0=$(now); incus import $D/final.tar m160-copie 2>&1 | tail -3; t1=$(now)
echo "IMPORT durée $(awk -v a=$t0 -v b=$t1 'BEGIN{printf "%.1f", b-a}') s"
echo "IMPORT instantanés: $(incus snapshot list m160-copie -f csv -c n | tr '\n' ' ')"
incus start m160-copie 2>&1 | tail -1
for i in $(seq 1 60); do incus exec m160-copie -- true 2>/dev/null && break; sleep 2; done
echo "COPIE /data: $(incus exec m160-copie -- ls /data | tr '\n' ' ')"
echo "COPIE journal: lignes=$(incus exec m160-copie -- sh -c 'wc -l < /data/journal') dernière=[$(incus exec m160-copie -- tail -n 1 /data/journal)]"
echo "COPIE sommes: $(incus exec m160-copie -- sh -c 'cd /data && sha256sum -c /root/sums 2>&1' | tr '\n' ' ')"
echo "--- restauration de s2 SANS drapeau (doit être refusée, DAT §19.1)"
incus snapshot restore m160-copie s2 2>&1 | tail -2
echo "--- restauration de s2 AVEC le drapeau de sparkd (zfs.remove_snapshots posé le temps du geste)"
incus query -X PATCH /1.0/instances/m160-copie -d '{"devices":{"root":{"type":"disk","path":"/","pool":"spark","zfs.remove_snapshots":"true"}}}' 2>&1 | tail -1
incus snapshot restore m160-copie s2 2>&1 | tail -2
incus query -X PATCH /1.0/instances/m160-copie -d '{"devices":{"root":{"type":"disk","path":"/","pool":"spark","zfs.remove_snapshots":"false"}}}' 2>&1 | tail -1
sleep 2
incus start m160-copie >/dev/null 2>&1
for i in $(seq 1 60); do incus exec m160-copie -- true 2>/dev/null && break; sleep 2; done
echo "APRÈS restauration s2 — instantanés: $(incus snapshot list m160-copie -f csv -c n | tr '\n' ' ')"
echo "APRÈS restauration s2 — /data: $(incus exec m160-copie -- ls /data | tr '\n' ' ')"
echo "APRÈS restauration s2 — base conforme à l'ORIGINAL (avant réécriture): $(incus exec m160-copie -- sh -c 'cd /data && sha256sum -c /root/base0.sha 2>&1' | tr '\n' ' ')"`, 1500);
    dire(`MESURE import sous un autre nom :\n${imp.sortie}`);

    // --- 5. l'envoi par parts de cet export vers un S3 ------------------------------------
    let upload = null;
    try {
      demarrerMinio({ nom: MINIO_VM, port: PORT_MINIO });
      if (!minioVivant(PORT_MINIO)) throw new Error('MinIO ne répond pas');
      jouerMc(PORT_MINIO, 'mc mb --ignore-existing l/spk160vm >/dev/null');
      const up = lib(String.raw`
/opt/sparkd/venv/bin/python -m pip install -q --target $D/b3 ${BOTO3} 2>&1 | tail -2
cat > $D/envoi.py <<'EOP'
import json, resource, sys, time
sys.path.insert(0, "/var/tmp/spk160/b3")
import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
M = 1024 * 1024
c = boto3.client("s3", endpoint_url="http://10.0.2.2:${PORT_MINIO}", region_name="us-east-1",
                 aws_access_key_id="${ADMIN.utilisateur}", aws_secret_access_key="${ADMIN.motDePasse}",
                 config=Config(signature_version="s3v4", s3={"addressing_style": "path"}, retries={"max_attempts": 1}))
f = "/var/tmp/spk160/final.tar"
import os
taille = os.path.getsize(f)
t = time.time()
c.upload_file(f, "spk160vm", "final.tar", Config=TransferConfig(multipart_threshold=64 * M, multipart_chunksize=64 * M, max_concurrency=1, use_threads=False))
d = time.time() - t
distant = c.head_object(Bucket="spk160vm", Key="final.tar")["ContentLength"]
print(json.dumps({"octets": taille, "octets_s3": distant, "secondes": round(d, 1), "mio_s": round(taille / M / d, 1),
                  "rss_max_mio": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024), "parts_de_64_mio": -(-taille // (64 * M))}))
EOP
/opt/sparkd/venv/bin/python $D/envoi.py 2>&1 | tail -3`, 1500);
      dire(`MESURE envoi par parts vers MinIO (10.0.2.2:${PORT_MINIO}) : ${up.sortie}`);
      try { upload = JSON.parse(up.sortie.trim().split('\n').pop()); } catch { upload = null; }
    } catch (erreur) {
      dire(`MESURE ÉCHEC de l'envoi : ${erreur.message}`);
    } finally {
      retirerConteneurs(MINIO_VM);
    }

    // --- 6. le pool DÉTRUIT puis RECRÉÉ, et l'export importé dessus ---------------------
    // Le scénario du sinistre : une Forge neuve a des disques vierges et un pool tout neuf.
    // Dernière étape : elle défait le pool de la machine, que le banc jette ensuite.
    const sinistre = lib(String.raw`
systemctl stop sparkd 2>&1 | tail -1
incus list -f csv -c n | xargs -r -n1 incus delete -f 2>&1 | tail -2
incus image list -f csv -c f | xargs -r -n1 incus image delete 2>&1 | tail -2
for p in $(incus profile list -f csv -c n); do incus profile device remove $p root 2>/dev/null; done
echo "--- suppression du pool: $(incus storage delete spark 2>&1 | tail -2)"
echo "zpool après: $(zpool list 2>&1 | head -2 | tr '\n' ' ')"
wipefs -a /dev/vdb /dev/vdc 2>&1 | tail -2
echo "--- recréation (la forme de creer-pool.sh): $(incus storage create spark zfs source=mirror=/dev/vdb,/dev/vdc 2>&1 | tail -2)"
incus profile device add default root disk path=/ pool=spark 2>&1 | tail -1
zpool status spark 2>&1 | sed -n 1,12p
t0=$(now); incus import $D/final.tar m160-neuf -s spark 2>&1 | tail -3; t1=$(now)
echo "IMPORT dans le pool recréé: durée $(awk -v a=$t0 -v b=$t1 'BEGIN{printf "%.1f", b-a}') s"
echo "NEUF instantanés: $(incus snapshot list m160-neuf -f csv -c n | tr '\n' ' ')"
incus start m160-neuf 2>&1 | tail -1
for i in $(seq 1 60); do incus exec m160-neuf -- true 2>/dev/null && break; sleep 2; done
echo "NEUF sommes: $(incus exec m160-neuf -- sh -c 'cd /data && sha256sum -c /root/sums 2>&1' | tr '\n' ' ')"
echo "NEUF /data: $(incus exec m160-neuf -- ls /data | tr '\n' ' ')"`, 1800);
    dire(`MESURE import dans un pool recréé :\n${sinistre.sortie}`);

    // --- 7. les seuils écrits à l'avance (DAT §67.2) ---------------------------------------
    const s5 = releves.find((r) => r.nom === 'opt-none-s5');
    if (s5 && !Number.isFinite(s5.zfs_used)) {
      verdict('(a) export optimisé à 5 instantanés ≤ données ZFS + 10 %', false,
        `taille de l’export relevée (${mio(s5.taille)}), mais le jeu de données ZFS n’a pas été relevé`);
    } else if (s5) {
      const plafond = 1.10 * s5.zfs_used;
      verdict('(a) export optimisé à 5 instantanés ≤ données ZFS (instantanés compris) + 10 %',
        s5.rc === 0 && s5.taille <= plafond,
        `${mio(s5.taille)} pour ${mio(s5.zfs_used)} utilisés (plafond ${mio(plafond)}), `
        + `durée ${s5.duree_s} s, CPU ${s5.cpu_s} s, espace de travail max ${mio(s5.espace_max)}`);
    } else {
      verdict('(a) export optimisé à 5 instantanés ≤ données ZFS + 10 %', false, 'aucune mesure à 5 instantanés');
    }
    /** La ligne de `sortie` qui suit `prefixe`, jusqu'à la fin de la ligne. */
    const ligne = (sortie, prefixe) => sortie.split(prefixe)[1]?.split('\n')[0] ?? '';
    const restitue = (t) => ['s1', 's2', 's3', 's4', 's5'].every((n) => t.split(/\s+/).includes(n));
    const intactes = (t) => ['base: OK', 'd1: OK', 'd2: OK', 'd3: OK', 'd4: OK', 'd5: OK'].every((x) => t.includes(x))
      && !/FAILED/.test(t);
    verdict('(b) l’import sous un autre nom restitue les 5 instantanés',
      restitue(ligne(imp.sortie, 'IMPORT instantanés:')), ligne(imp.sortie, 'IMPORT instantanés:').trim() || 'absent');
    verdict('(b) les sommes de contrôle de la copie sont intactes',
      intactes(ligne(imp.sortie, 'COPIE sommes:')), ligne(imp.sortie, 'COPIE sommes:').trim().slice(0, 200) || 'absent');
    verdict('(b) la restauration de s2 sur la copie rend la base d’AVANT la réécriture',
      /OK/.test(ligne(imp.sortie, 'conforme à l\'ORIGINAL (avant réécriture):')) && !/FAILED/.test(ligne(imp.sortie, 'conforme à l\'ORIGINAL (avant réécriture):')),
      ligne(imp.sortie, 'conforme à l\'ORIGINAL (avant réécriture):').trim() || 'absent');
    verdict('l’import dans un pool recréé restitue les 5 instantanés et des données intactes',
      restitue(ligne(sinistre.sortie, 'NEUF instantanés:')) && intactes(ligne(sinistre.sortie, 'NEUF sommes:')),
      `${ligne(sinistre.sortie, 'NEUF instantanés:').trim()} | ${ligne(sinistre.sortie, 'NEUF sommes:').trim().slice(0, 160)}`);
    verdict('l’envoi par parts de l’export vers MinIO aboutit à la taille exacte',
      Boolean(upload) && upload.octets === upload.octets_s3,
      upload ? `${mio(upload.octets)} en ${upload.secondes} s (${upload.mio_s} Mio/s), mémoire max ${upload.rss_max_mio} Mio` : 'aucune mesure');

    // --- 8. le relevé complet, pour le DAT et le journal ----------------------------------
    dire(`RELEVE_JSON ${JSON.stringify({ releves, upload })}`);
  } catch (erreur) {
    verdict('la mesure SPK-160 est allée au bout', false, erreur.message);
  }
}
