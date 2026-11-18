/**
 * Un destinataire SMTP jetable, pour éprouver le canal courriel de SPK-62 de bout en bout.
 *
 * @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.2 (le canal SMTP), §47.3.2 ter (couper un
 *       canal le dit, par lui), §47.4 (ce que l'envoi porte)
 *
 * C'est un VRAI serveur SMTP sur une socket, sans TLS ni authentification (le mode « Aucun » de
 * l'écran, un relais interne) : ce qu'on mesure est ce qui part sur le réseau, pas ce qu'on croit
 * avoir donné à `smtplib`. Même motif que `notify-doublon.mjs`. Les modes TLS et le compte sont
 * prouvés contre un serveur Python qui les parle vraiment (`services/sparkd/tests/smtp_local.py`).
 */

import { createServer } from 'node:net';

export async function monterSmtpDoublon() {
  const recus = [];

  const serveur = createServer((socket) => {
    socket.setEncoding('utf8');
    let tampon = '';
    let donnees = null;
    let expediteur = null;
    let destinataires = [];
    const dire = (texte) => socket.write(`${texte}\r\n`);
    dire('220 localhost ESMTP doublon');
    socket.on('data', (bloc) => {
      tampon += bloc;
      let fin;
      // eslint-disable-next-line no-cond-assign
      while ((fin = tampon.indexOf('\r\n')) !== -1) {
        const ligne = tampon.slice(0, fin);
        tampon = tampon.slice(fin + 2);
        if (donnees !== null) {
          if (ligne === '.') {
            recus.push({ de: expediteur, a: [...destinataires], brut: donnees.join('\r\n') });
            donnees = null;
            destinataires = [];
            dire('250 OK queued');
          } else {
            donnees.push(ligne.startsWith('..') ? ligne.slice(1) : ligne);
          }
          continue;
        }
        const verbe = ligne.split(' ', 1)[0].toUpperCase();
        if (verbe === 'EHLO' || verbe === 'HELO') socket.write('250-localhost\r\n250 8BITMIME\r\n');
        else if (verbe === 'MAIL') { expediteur = ligne.split(':')[1].trim().replace(/[<>]/g, ''); dire('250 OK'); }
        else if (verbe === 'RCPT') { destinataires.push(ligne.split(':')[1].trim().replace(/[<>]/g, '')); dire('250 OK'); }
        else if (verbe === 'DATA') { donnees = []; dire('354 End data with <CR><LF>.<CR><LF>'); }
        else if (verbe === 'RSET') dire('250 OK');
        else if (verbe === 'QUIT') { dire('221 Bye'); socket.end(); }
        else dire('502 non géré');
      }
    });
    socket.on('error', () => {});
  });

  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const port = serveur.address().port;

  return {
    port,
    recus,
    /** Attend qu'au moins `n` courriels soient arrivés, ou rend ce qu'il y a. */
    async attendre(n = 1, { tentatives = 80, delaiMs = 100 } = {}) {
      for (let i = 0; i < tentatives && recus.length < n; i += 1) {
        await new Promise((r) => setTimeout(r, delaiMs));
      }
      return recus;
    },
    /** Le texte d'un courriel, quoted-printable décodé : ce que le destinataire lirait. */
    texte(courriel) {
      const corps = courriel.brut.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      const souple = corps.replace(/=\r\n/g, '');
      return Buffer.from(souple.replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1')
        .toString('utf8');
    },
    oublier() { recus.length = 0; },
    demonter() { return new Promise((r) => serveur.close(r)); },
  };
}
