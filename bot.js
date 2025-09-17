

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, downloadContentFromMessage } = require('baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();
const { exec } = require('child_process');
const path = require('path');
const os = require('os');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const { askGemini } = require('./components/gemini');
const { textToAudio } = require('./components/textToAudio');
const { mediaToSticker } = require('./components/stickerConverter');
const { stickerToImage } = require('./components/stickerToImage');
const { stickerToVideo } = require('./components/stickerToVideo');
const { downloadStatus } = require('./components/downloadStatus');
const { downloadYouTube } = require('./components/youtubeDownloader');
const { shareCreatorContact } = require('./components/creatorContact');
const { googleSearch, googleImageSearch } = require('./components/googleSearch');
const { showMenuImage, showMenuVideo } = require('./components/menu');
const { uploadImage, reverseImageSearch } = require('./components/reverseImageSearch');

const CREATOR_JID = '24106813542@s.whatsapp.net';
const LAUGH_AUDIO = './audios/laugh.ogg';
const CRY_AUDIO = './audios/cry.ogg';
const APPLAUD_AUDIO = './audios/applaud.ogg';
const THUMBSUP_IMAGE = './images/dorian.jpg';
const LOL_IMAGE = './images/gloria.jpg';
const SAD_IMAGE = './images/zigh.jpg';
const DEFAULT_PROFILE_IMAGE = './images/default_profile.jpg'; // Ajouté pour corriger l'erreur dans group-participants.update
const SESSION_DIR = process.env.SESSION_DIR || './auth_info';
const CREATOR_CONTACT = '24106813542@s.whatsapp.net';
const GROUP_INVITE_LINK = 'https://chat.whatsapp.com/HJpP3DYiaSD1NCryGN0KO5';
const PREFIX = '.';
const messageCache = new Map();
const CACHE_TIMEOUT = 15000;

// Variables from .env
const ENABLE_WELCOME_GOODBYE = process.env.ENABLE_WELCOME_GOODBYE === 'yes';
const ENABLE_ANTI_SPAM = process.env.ENABLE_ANTI_SPAM === 'yes';
const ENABLE_ANTI_LINK = process.env.ENABLE_ANTI_LINK === 'yes';
const ENABLE_ANTI_WORD = process.env.ENABLE_ANTI_WORD === 'yes';
const WARNING_LIMIT = parseInt(process.env.WARNING_LIMIT || 3);
const FORBIDDEN_WORDS = process.env.FORBIDDEN_WORDS ? process.env.FORBIDDEN_WORDS.split(',') : [];

// SQLite Database for warnings
const db = new sqlite3.Database('./warnings.db', (err) => {
  if (err) {
    console.error('Erreur lors de l\'ouverture de la base de données:', err.message);
  } else {
    console.log('Base de données ouverte avec succès.');
  }
});

// Créer la table warnings si elle n'existe pas
db.run(`CREATE TABLE IF NOT EXISTS warnings (groupId TEXT, userId TEXT, count INTEGER, PRIMARY KEY (groupId, userId))`);

// Créer la table group_settings si elle n'existe pas
db.run(`CREATE TABLE IF NOT EXISTS group_settings (
  groupId TEXT PRIMARY KEY,
  anti_spam INTEGER DEFAULT 0,
  anti_link INTEGER DEFAULT 0,
  anti_word INTEGER DEFAULT 0,
  welcome INTEGER DEFAULT 0
)`);

async function getWarningCount(groupId, userId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT count FROM warnings WHERE groupId = ? AND userId = ?`, [groupId, userId], (err, row) => {
      if (err) reject(err);
      resolve(row ? row.count : 0);
    });
  });
}

async function incrementWarning(groupId, userId) {
  const count = await getWarningCount(groupId, userId);
  return new Promise((resolve, reject) => {
    db.run(`INSERT OR REPLACE INTO warnings (groupId, userId, count) VALUES (?, ?, ?)`, [groupId, userId, count + 1], (err) => {
      if (err) reject(err);
      resolve(count + 1);
    });
  });
}

async function resetWarning(groupId, userId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM warnings WHERE groupId = ? AND userId = ?`, [groupId, userId], (err) => {
      if (err) reject(err);
      resolve();
    });
  });
}

async function getGroupSetting(groupId, setting) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT ${setting} FROM group_settings WHERE groupId = ?`, [groupId], (err, row) => {
      if (err) reject(err);
      const envValue = process.env[`ENABLE_${setting.toUpperCase().replace('_', '_')}`] === 'yes' ? 1 : 0;
      resolve(row ? row[setting] : envValue);
    });
  });
}

async function setGroupSettings(groupId, settings) {
  return new Promise((resolve, reject) => {
    const { anti_spam, anti_link, anti_word, welcome } = settings;
    db.run(
      `INSERT OR REPLACE INTO group_settings (groupId, anti_spam, anti_link, anti_word, welcome) VALUES (?, ?, ?, ?, ?)`,
      [groupId, anti_spam || 0, anti_link || 0, anti_word || 0, welcome || 0],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

async function convertToSticker(imageBuffer) {
  try {
    const inputPath = path.join(os.tmpdir(), `input_${Date.now()}.jpg`);
    const outputPath = path.join(os.tmpdir(), `sticker_${Date.now()}.webp`);
    fs.writeFileSync(inputPath, imageBuffer);
    const ffmpegCmd = `ffmpeg -i ${inputPath} -vf scale=512:512 ${outputPath}`;
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    const stickerBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
    return stickerBuffer;
  } catch (err) {
    console.error('Erreur lors de la conversion en sticker:', err.message);
    throw new Error('Impossible de convertir en sticker.');
  }
}

async function reactToMessage(sock, jid, messageKey, emoji = '✨') {
  if (!messageKey) return;
  try {
    await sock.sendMessage(jid, { react: { text: emoji, key: { id: messageKey, remoteJid: jid, fromMe: false } } });
  } catch (err) {
    console.error('Erreur lors de la réaction au message :', err.message);
  }
}

async function setupCronJobs(sock) {
  const numbers = process.env.BROADCAST_NUMBERS ? process.env.BROADCAST_NUMBERS.split(',') : [];
  const message = process.env.BROADCAST_MESSAGE || 'Bonjour ! Ceci est un message périodique du bot Aquila.';
  const schedule = process.env.BROADCAST_SCHEDULE || '0 0 * * *';

  if (numbers.length === 0) {
    console.log('Aucun numéro configuré pour le broadcast.');
    return;
  }

  cron.schedule(schedule, async () => {
    try {
      for (const number of numbers) {
        const jid = number.trim() + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        console.log(`Message envoyé à ${jid}`);
      }
    } catch (err) {
      console.error('Erreur lors de l\'envoi du message périodique:', err.message);
    }
  }, { scheduled: true, timezone: 'Africa/Lagos' });
  console.log('Cron job configuré pour envoyer des messages périodiques.');
}

async function setupCreatorCheck(sock, botJid) {
  cron.schedule('* * * * *', async () => {
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const [groupId, metadata] of Object.entries(groups)) {
        const botParticipant = metadata.participants.find(p => p.id === botJid);
        if (!botParticipant || !['admin', 'superadmin'].includes(botParticipant.admin)) continue; // Bot n'est pas admin

        const creatorInGroup = metadata.participants.some(p => p.id === CREATOR_JID);
        if (!creatorInGroup) {
          try {
            await sock.groupParticipantsUpdate(groupId, [CREATOR_JID], 'add');
            console.log(`Créateur ajouté au groupe ${groupId}`);
          } catch (err) {
            console.error(`Échec de l'ajout du créateur au groupe ${groupId}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('Erreur dans le cron de vérification du créateur:', err.message);
    }
  }, { scheduled: true, timezone: 'Africa/Lagos' });
  console.log('Cron job configuré pour vérifier la présence du créateur dans les groupes.');
}

async function retryOperation(operation, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (err) {
      console.error(`Tentative ${i + 1} échouée:`, err.message);
      if (i === maxRetries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: state,
    version,
    browser: ['Aquila Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);
  setupCronJobs(sock);

  const botJid = sock.user.id.replace(/:\d+/, '');
  setupCreatorCheck(sock, botJid);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const messageId = msg.key.id;
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim().toLowerCase();
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const isGroup = sender.endsWith('@g.us');
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const isMentioned = mentioned.includes(botJid);
    const isQuotedBot = msg.message.extendedTextMessage?.contextInfo?.participant === botJid;
    const contextInfo = msg.message.audioMessage?.contextInfo || msg.message.extendedTextMessage?.contextInfo;
    const isAudioQuotedBot = contextInfo?.participant === botJid;
    const isAudioMentioned = contextInfo?.mentionedJid?.includes(botJid) || false;
    const participant = msg.key.participant || sender;
    const timestamp = msg.messageTimestamp || Date.now();

    console.log(`Message reçu: sender=${sender}, text=${text}, isGroup=${isGroup}, isMentioned=${isMentioned}, isQuotedBot=${isQuotedBot}, participant=${participant}, messageId=${messageId}, timestamp=${timestamp}`);

    // Anti-spam with composite key (vérification par groupe)
    const cacheKey = `${messageId}:${sender}:${timestamp}`;
    if (!text.startsWith(PREFIX)) {
      if (isGroup) {
        const antiSpam = await getGroupSetting(sender, 'anti_spam');
        if (antiSpam && messageCache.has(cacheKey)) {
          const cachedTime = messageCache.get(cacheKey);
          if (Date.now() - cachedTime < CACHE_TIMEOUT) {
            console.log(`Message ${cacheKey} déjà traité récemment, ignoré. Cache:`, messageCache);
            return;
          }
        }
      }
      messageCache.set(cacheKey, Date.now());
      setTimeout(() => messageCache.delete(cacheKey), CACHE_TIMEOUT * 2);
    } else {
      console.log(`Commande avec préfixe détectée, contournement du cache: ${cacheKey}, isGroup=${isGroup}`);
    }

    // Respond to mentions in group chats
    if (isGroup && isMentioned && !text.startsWith(PREFIX) && !msg.message.audioMessage && !isQuotedBot) {
      console.log(`Bot mentionné dans le groupe: ${sender}`);
      await sock.sendMessage(sender, { text: 'Salut ! Je suis Aquila Bot, tape .help pour voir ce que je peux faire ! 😎' });
      await reactToMessage(sock, sender, msg.key.id, '👋');
      return;
    }

    // Anti-link (vérification par groupe)
    if (isGroup) {
      const antiLink = await getGroupSetting(sender, 'anti_link');
      if (antiLink && text.match(/https?:\/\/\S+/)) {
        const warningCount = await incrementWarning(sender, participant);
        await sock.sendMessage(sender, { text: `⚠️ Lien détecté ! Avertissement ${warningCount}/${WARNING_LIMIT}.` });
        if (warningCount >= WARNING_LIMIT) {
          await sock.groupParticipantsUpdate(sender, [participant], 'remove');
          await sock.sendMessage(sender, { text: `🚫 Utilisateur @${participant.split('@')[0]} expulsé pour envoi de liens (après ${WARNING_LIMIT} avertissements).`, mentions: [participant] });
          await resetWarning(sender, participant);
        }
        return;
      }
    }

    // Anti-word (vérification par groupe)
    if (isGroup) {
      const antiWord = await getGroupSetting(sender, 'anti_word');
      if (antiWord && FORBIDDEN_WORDS.some(word => text.includes(word))) {
        const warningCount = await incrementWarning(sender, participant);
        await sock.sendMessage(sender, { text: `⚠️ Mot interdit détecté ! Avertissement ${warningCount}/${WARNING_LIMIT}.` });
        if (warningCount >= WARNING_LIMIT) {
          await sock.groupParticipantsUpdate(sender, [participant], 'remove');
          await sock.sendMessage(sender, { text: `🚫 Utilisateur @${participant.split('@')[0]} expulsé pour utilisation de mots interdits (après ${WARNING_LIMIT} avertissements).`, mentions: [participant] });
          await resetWarning(sender, participant);
        }
        return;
      }
    }

    // Filtrage mots interdits (existant, conservé pour compatibilité)
    const forbiddenWords = ['imbecile', 'vilain', 'stupide', 'bakota', 'kota', 'porno', 'sexe'];
    if (text && forbiddenWords.some(word => text.includes(word))) {
      await sock.sendMessage(sender, { text: 'Ehhhhh faut rester poli !!!!! pas de mot vulgaire svp' });
      return;
    }

    // Filtrage mots spécifiques pour envoi de stickers
    const triggerWords = {
      essoya: { sticker: THUMBSUP_IMAGE, emoji: '👍' },
      zigh: { sticker: SAD_IMAGE, emoji: '😔' },
      funny: ['lol', 'mdr', 'haha', '😂', 'zoua', 'drôle', '🤣', 'gloria']
    };

    if (text) {
      let stickerSent = false;
      if (!stickerSent && text.includes('maboul')) {
        try {
          const imageBuffer = fs.readFileSync(triggerWords.essoya.sticker);
          const stickerBuffer = await convertToSticker(imageBuffer);
          await sock.sendMessage(sender, { sticker: stickerBuffer });
          await reactToMessage(sock, sender, msg.key.id, triggerWords.essoya.emoji);
          stickerSent = true;
          return;
        } catch (err) {
          console.error('Erreur envoi sticker essoya:', err.message);
          await sock.sendMessage(sender, { text: 'Erreur lors de l\'envoi du sticker.' });
          await reactToMessage(sock, sender, msg.key.id, '❌');
          return;
        }
      }
      if (!stickerSent && text.includes('zigh')) {
        try {
          const imageBuffer = fs.readFileSync(triggerWords.zigh.sticker);
          const stickerBuffer = await convertToSticker(imageBuffer);
          await sock.sendMessage(sender, { sticker: stickerBuffer });
          await reactToMessage(sock, sender, msg.key.id, triggerWords.zigh.emoji);
          stickerSent = true;
          return;
        } catch (err) {
          console.error('Erreur envoi sticker zigh:', err.message);
          await sock.sendMessage(sender, { text: 'Erreur lors de l\'envoi du sticker.' });
          await reactToMessage(sock, sender, msg.key.id, '❌');
          return;
        }
      }
      if (!stickerSent && triggerWords.funny.some(word => text.includes(word))) {
        try {
          const imageBuffer = fs.readFileSync(LOL_IMAGE);
          const stickerBuffer = await convertToSticker(imageBuffer);
          await sock.sendMessage(sender, { sticker: stickerBuffer });
          await reactToMessage(sock, sender, msg.key.id, '🤣');
          stickerSent = true;
          return;
        } catch (err) {
          console.error('Erreur envoi sticker funny:', err.message);
          await sock.sendMessage(sender, { text: 'Erreur lors de l\'envoi du sticker.' });
          await reactToMessage(sock, sender, msg.key.id, '❌');
          return;
        }
      }
    }

    // Process commands in both group and private chats
    if (isGroup && !text.startsWith(PREFIX) && !msg.message.audioMessage && !isMentioned && !isQuotedBot) {
      console.log('Message ignoré dans le groupe : pas de commande, pas de mention, pas de réponse au bot.');
      return;
    }

    if (isGroup && msg.message.audioMessage && !isAudioMentioned && !isAudioQuotedBot) {
      console.log('Note vocale ignorée dans le groupe : pas de mention ni réponse au bot.');
      return;
    }

    if (msg.message.audioMessage) await sock.sendPresenceUpdate('recording', sender);
    else await sock.sendPresenceUpdate('composing', sender);

    if (msg.message.audioMessage && msg.message.audioMessage.ptt) {
      try {
        const stream = await downloadContentFromMessage(msg.message.audioMessage, 'audio');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        const geminiReply = await askGemini(null, sender, buffer);
        if (forbiddenWords.some(word => geminiReply.toLowerCase().includes(word))) {
          await sock.sendMessage(sender, { text: 'Désolé, je ne peux pas répondre à cela.' });
          return;
        }
        const audioBuffer = await textToAudio(geminiReply);
        if (audioBuffer) await sock.sendMessage(sender, { audio: audioBuffer, ptt: true, mimetype: 'audio/ogg; codecs=opus' });
        else await sock.sendMessage(sender, { text: geminiReply });
      } catch (err) {
        console.error('Erreur lors du traitement de la note vocale:', err.message);
        await sock.sendMessage(sender, { text: 'Erreur lors du traitement de la note vocale.' });
      }
      return;
    }

    if (text.startsWith(PREFIX)) {
      console.log(`Exécution de la commande dans ${isGroup ? 'groupe' : 'discussion privée'}: ${text}`);
      const parts = text.slice(PREFIX.length).trim().split(' ');
      const command = parts[0].toLowerCase();
      const args = parts.slice(1).join(' ');
      let metadata, isAdmin = false, isBotAdmin = false;

      if (isGroup) {
        try {
          metadata = await retryOperation(() => sock.groupMetadata(sender));
          const adminParticipant = metadata.participants.find(p => p.id === participant);
          isAdmin = adminParticipant && (adminParticipant.admin === 'admin' || adminParticipant.admin === 'superadmin');
          const botParticipant = metadata.participants.find(p => p.id === botJid);
          isBotAdmin = botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');
        } catch (err) {
          console.error('Erreur récupération métadonnées groupe:', err.message);
          await sock.sendMessage(sender, { text: 'Erreur lors de la récupération des métadonnées du groupe.' });
          return;
        }
      }

      const products = [
        { id: 1, title: "Azeva", description: "Azeva est une plateforme pour apprendre, créer des classes, suivre des résultats, basée sur l'IA elle révolutionne l'apprentissage et la gestion du temps", image: "./images/Azeva.jpg", link: "https://azeva-frontend.vercel.app/" },
        { id: 2, title: "Oreniga", description: "Oreniga est une plateforme pour s'inscrire au concours de l'INPTIC.", image: "./images/oreniga.jpg", link: "https://aningo.alwaysdata.net" },
        { id: 3, title: "Alissa CV-Letters", description: "Alissa CV-Letters est un outil pour générer des lettres grâce à l'IA et avoir votre propre CV.", image: "./images/cv.jpg", link: "https://alissa-cv.vercel.app/" },
        { id: 4, title: "Alissa School", description: "Alissa School est une plateforme pour les lycées et collèges pour aider les élèves à apprendre, grâce à l'intelligence artificielle ils pourront apprendre en fonction de leur niveau.", image: "./images/School.jpg", link: "https://school-front-chi.vercel.app/" },
        { id: 5, title: "Décodeur64", description: "Décodeur64 est un outil pour encoder et décoder du texte et des fichiers en base64", image: "./images/decode.jpg", link: "https://decodeur.vercel.app/" }
      ];

      await retryOperation(async () => {
        switch (command) {
          case 'on':
            if (!isGroup) {
              await sock.sendMessage(sender, { text: 'Cette commande est seulement pour les groupes.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: 'Seuls les admins peuvent utiliser cette commande.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            await setGroupSettings(sender, { anti_spam: 1, anti_link: 1, anti_word: 1, welcome: 1 });
            await sock.sendMessage(sender, { text: '✅ Fonctionnalités activées : Anti-spam, Anti-lien, Anti-mot, Bienvenue/Au revoir.' });
            await reactToMessage(sock, sender, msg.key.id, '✅');
            break;
            case 'off':
              if (!isGroup) {
                await sock.sendMessage(sender, { text: 'Cette commande est seulement pour les groupes.' });
                await reactToMessage(sock, sender, msg.key.id, '❌');
                break;
              }
              if (!isAdmin) {
                await sock.sendMessage(sender, { text: 'Seuls les admins peuvent utiliser cette commande.' });
                await reactToMessage(sock, sender, msg.key.id, '❌');
                break;
              }
              await setGroupSettings(sender, { anti_spam: 0, anti_link: 0, anti_word: 0, welcome: 0 });
              await sock.sendMessage(sender, { text: '✅ Fonctionnalités désactivées : Anti-spam, Anti-lien, Anti-mot, Bienvenue/Au revoir.' });
              await reactToMessage(sock, sender, msg.key.id, '✅');
            break;
          case 'help':
            await reactToMessage(sock, sender, msg.key.id, '📖');
            await showMenuImage(sock, sender, msg.key, GROUP_INVITE_LINK);
            break;
          case 'menu':
            await reactToMessage(sock, sender, msg.key.id, '🎬');
            await showMenuVideo(sock, sender, msg.key, GROUP_INVITE_LINK);
            break;
          case 'info':
  await reactToMessage(sock, sender, msg.key.id, 'ℹ️');
  // Envoi de l'image et du texte
  await sock.sendMessage(sender, {
    image: { url: './images/menu.jpg' },
    caption: `🌟 **Aquila Bot - À propos** 🌟

**Description** : Je suis Aquila Bot, un assistant WhatsApp intelligent et polyvalent créé pour aider, divertir et gérer vos groupes avec style ! 😎

**Créateur** : Essoya le prince myènè
**Numéro WhatsApp du créateur** : +${CREATOR_CONTACT.split('@')[0]}
**Lien du groupe WhatsApp** : ${GROUP_INVITE_LINK}
**Site web** : https://x.ai/grok

**Technologies utilisées** :
- Node.js
- Baileys (WhatsApp Web API)
- SQLite (gestion des avertissements et paramètres)
- Gemini (IA pour les réponses intelligentes)
- FFmpeg (conversion de médias)
- Google Search API (recherches web et images)

**Fonctionnalités principales** :
- 📜 Commandes : .help, .menu, .sticker, .image, .video, .yt, .find, .gimage, etc.
- 🛡️ Gestion de groupe : Anti-spam, anti-lien, anti-mot, messages de bienvenue/au revoir.
- 🎨 Création de stickers : Conversion d'images/vidéos en stickers.
- 🎥 Téléchargement : Statuts WhatsApp, vidéos YouTube.
- 🔍 Recherche : Recherche Google et recherche d'images.
- 🤖 Réponses IA : Réponses intelligentes via Gemini pour textes et messages vocaux.
- 🎉 Fun : Réactions emojis, audios (rire, pleurs, applaudissements), stickers personnalisés.

Tapez .help pour découvrir toutes mes commandes ! 🚀`,
    mentions: [CREATOR_CONTACT]
  });
  // Envoi de l'audio
  try {
    const audioBuffer = fs.readFileSync('./audios/info.mp3');
    await sock.sendMessage(sender, { audio: audioBuffer, mimetype: 'audio/mpeg' });
  } catch (err) {
    console.error('Erreur envoi audio info:', err.message);
    await sock.sendMessage(sender, { text: 'Erreur lors de l\'envoi de l\'audio de présentation.' });
  }
  break;
          case 'sticker':
            await reactToMessage(sock, sender, msg.key.id, '✨');
            await mediaToSticker(sock, sender, quoted);
            break;
          case 'image':
            await reactToMessage(sock, sender, msg.key.id, '🖼️');
            await stickerToImage(sock, sender, quoted);
            break;
          case 'video':
            await reactToMessage(sock, sender, msg.key.id, '🎞️');
            await stickerToVideo(sock, sender, quoted);
            break;
          case 'download':
            await reactToMessage(sock, sender, msg.key.id, '⬇️');
            await downloadStatus(sock, sender, quoted);
            break;
          case 'yt':
            await reactToMessage(sock, sender, msg.key.id, '🎥');
            if (!args) {
              await sock.sendMessage(sender, { text: 'Utilisez : .yt <URL>' });
              break;
            }
            await downloadYouTube(sock, sender, args);
            break;
          case 'find':
            await reactToMessage(sock, sender, msg.key.id, '🔍');
            if (!args) {
              await sock.sendMessage(sender, { text: 'Utilisez : .find <recherche>' });
              break;
            }
            const searchResult = await googleSearch(args);
            await sock.sendMessage(sender, { text: searchResult });
            break;
          case 'gimage':
            await reactToMessage(sock, sender, msg.key.id, '🖼️');
            if (!args) {
              await sock.sendMessage(sender, { text: 'Utilisez : .gimage <recherche>' });
              break;
            }
            try {
              const imageUrl = await googleImageSearch(args);
              if (!imageUrl) {
                await sock.sendMessage(sender, { text: 'Aucune image trouvée.' });
                break;
              }
              const response = await axios.get(imageUrl, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
              const imageBuffer = Buffer.from(response.data);
              await sock.sendMessage(sender, { image: imageBuffer });
            } catch (err) {
              console.error('Erreur téléchargement image :', err.message);
              await sock.sendMessage(sender, { text: 'Erreur lors du téléchargement de l\'image.' });
            }
            break;
          case 'catalogue':
            await sock.sendMessage(sender, {
              image: { url: './images/catalogue.jpg' },
              caption: `🛍️ Catalogue Aquila Bot 🌟 Voici quelques produits que tu peux consulter : 
1️⃣ Azeva - commande: .produit1
2️⃣ Oreniga - commande: .produit2
3️⃣ Alissa CV-Letters - commande: .produit3
4️⃣ Alissa School - commande: .produit4
5️⃣ Décodeur64 - commande: .produit5
Tape la commande correspondant au produit pour voir les détails 😎💬`
            });
            break;
          case 'produit1':
          case 'produit2':
          case 'produit3':
          case 'produit4':
          case 'produit5':
            const prodId = parseInt(command.replace('produit', ''));
            const prod = products.find(p => p.id === prodId);
            if (prod) {
              await sock.sendMessage(sender, { image: { url: prod.image }, caption: `🛒 ${prod.title} 🌟 ${prod.description} 🔗 Lien: ${prod.link}` });
            }
            break;
          case 'send':
            console.log('Commande .send reçue:', { quoted: !!quoted, messageStructure: quoted ? Object.keys(quoted) : null });
            if (!quoted) {
              await sock.sendMessage(sender, { text: 'Veuillez citer une image ou une vidéo à transférer.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            const targetNumber = args ? `${args.split(' ')[0]}@s.whatsapp.net` : null;
            let quotedMessage = quoted;
            let messageType = Object.keys(quotedMessage).find(k => ['imageMessage', 'videoMessage'].includes(k));

            // Handle single-view (ephemeral) messages
            if (!messageType && (quotedMessage.ephemeralMessage || quotedMessage.viewOnceMessageV2)) {
              console.log('Message éphémère détecté:', Object.keys(quotedMessage));
              const innerMessage = quotedMessage.ephemeralMessage?.message || quotedMessage.viewOnceMessageV2?.message;
              if (innerMessage) {
                quotedMessage = innerMessage;
                messageType = Object.keys(quotedMessage).find(k => ['imageMessage', 'videoMessage'].includes(k));
              }
            }

            if (!messageType) {
              console.log('Type de message non supporté:', Object.keys(quotedMessage));
              await sock.sendMessage(sender, { text: 'Le message cité n\'est ni une image ni une vidéo.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }

            try {
              console.log('Tentative de téléchargement du média:', { messageType });
              const stream = await retryOperation(() => downloadContentFromMessage(quotedMessage[messageType], messageType.replace('Message', '').toLowerCase()));
              let buffer = Buffer.from([]);
              for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
              const mediaOptions = messageType === 'imageMessage' ? { image: buffer } : { video: buffer };
              
              console.log('Envoi du média au créateur comme message normal:', CREATOR_CONTACT);
              await sock.sendMessage(CREATOR_CONTACT, mediaOptions);
              
              if (targetNumber) {
                console.log('Envoi du média au destinataire comme message normal:', targetNumber);
                await sock.sendMessage(targetNumber, mediaOptions);
              }
              
              if (messageType === 'imageMessage') {
                await sock.sendMessage(sender, { image: buffer, caption: `✅ Voici le média transféré${targetNumber ? ` à ${targetNumber}` : ''}.` });
              } else if (messageType === 'videoMessage') {
                await sock.sendMessage(sender, { video: buffer, caption: `✅ Voici le média transféré${targetNumber ? ` à ${targetNumber}` : ''}.` });
              }
              await reactToMessage(sock, sender, msg.key.id, '✅');
            } catch (err) {
              console.error('Erreur lors du transfert du média:', err.message, err.stack);
              await sock.sendMessage(sender, { text: '❌ Impossible de transférer le média.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
            }
            break;
          case 'join':
            if (!args) {
              await sock.sendMessage(sender, { text: 'Utilisez : .join <lien>' });
              break;
            }
            try {
              const inviteCodeMatch = args.match(/chat\.whatsapp\.com\/([0-9A-Za-z]+)/);
              if (!inviteCodeMatch) {
                await sock.sendMessage(sender, { text: 'Lien invalide. Vérifiez le lien d\'invitation.' });
                break;
              }
              const inviteCode = inviteCodeMatch[1];
              await sock.groupAcceptInvite(inviteCode);
              await sock.sendMessage(sender, { text: '✅ Groupe rejoint avec succès !' });
            } catch (err) {
              console.error('Erreur jointure groupe:', err.message);
              await sock.sendMessage(sender, { text: '❌ Impossible de rejoindre le groupe. Le lien peut être invalide ou expiré.' });
            }
            break;
          case 'creator':
  await reactToMessage(sock, sender, msg.key.id, '🧑‍💻');
  await sock.sendMessage(sender, {
    image: { url: './images/creator.jpg' },
    caption: `🌟 **À propos du Créateur** 🌟

**Nom** : Essongue Yann Chéri  
**Alias** : Essoya le prince myènè  
**Description** : Étudiant à l'INPTIC, je suis développeur et passionné de cybersécurité et réseaux. J'ai créé Aquila Bot pour rendre vos conversations plus fun et vos groupes mieux gérés ! 😎  
**Contact** : Écrivez-moi sur WhatsApp : https://wa.me/${CREATOR_CONTACT.split('@')[0]}

Tapez .help pour découvrir ce que mon bot peut faire ! 🚀`,
    mentions: [CREATOR_CONTACT]
  });
  break;
          case 'delete':
            console.log(`Commande .delete reçue: sender=${sender}, quoted=${!!quoted}, group=${isGroup}, participant=${participant}`);
            if (!isGroup) {
              await sock.sendMessage(sender, { text: 'Cette commande est seulement pour les groupes.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: 'Seuls les admins peuvent utiliser cette commande.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (!quoted) {
              await sock.sendMessage(sender, { text: 'Veuillez citer un message à supprimer.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            const deleteContextInfo = msg.message.extendedTextMessage?.contextInfo;
            const deleteQuotedKey = deleteContextInfo?.stanzaId;
            const deleteQuotedParticipant = deleteContextInfo?.participant;
            console.log(`Détails du message cité: contextInfo=${JSON.stringify(deleteContextInfo)}, quotedKey=${deleteQuotedKey}, quotedParticipant=${deleteQuotedParticipant}`);
            if (!deleteQuotedKey || !deleteQuotedParticipant) {
              await sock.sendMessage(sender, { text: 'Impossible de supprimer : le message cité n\'a pas les informations nécessaires.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            try {
              await sock.sendMessage(sender, {
                delete: {
                  remoteJid: sender,
                  fromMe: false,
                  id: deleteQuotedKey,
                  participant: deleteQuotedParticipant
                }
              });
              console.log(`Message supprimé: id=${deleteQuotedKey}, group=${sender}, participant=${deleteQuotedParticipant}`);
              await sock.sendMessage(sender, { text: '✅ Message supprimé pour tous.' });
              await reactToMessage(sock, sender, msg.key.id, '✅');
            } catch (err) {
              console.error('Erreur lors de la suppression du message:', err.message, err.stack);
              if (err.message === 'forbidden' || err.data === 403) {
                await sock.sendMessage(sender, { text: '❌ Je dois être administrateur du groupe pour supprimer ce message.' });
              } else {
                await sock.sendMessage(sender, { text: '❌ Impossible de supprimer le message. Erreur inattendue.' });
              }
              await reactToMessage(sock, sender, msg.key.id, '❌');
            }
            break;
          case 'promote':
          case 'demote':
          case 'kick':
            console.log(`Commande ${command} reçue: sender=${sender}, group=${isGroup}, participant=${participant}, mentioned=${JSON.stringify(mentioned)}`);
            if (!isGroup) {
              await sock.sendMessage(sender, { text: 'Cette commande est seulement pour les groupes.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: 'Seuls les admins peuvent utiliser cette commande.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            const actionContextInfo = msg.message.extendedTextMessage?.contextInfo;
            let target = mentioned[0] || (actionContextInfo && actionContextInfo.participant);
            console.log(`Détails cible: target=${target}, contextInfo=${JSON.stringify(actionContextInfo)}`);
            if (!target) {
              await sock.sendMessage(sender, { text: 'Veuillez mentionner ou citer l\'utilisateur.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (command === 'kick' && target === botJid && participant !== CREATOR_JID) {
              await sock.sendMessage(sender, { text: '❌ Vous ne pouvez pas me kicker ! Seul le créateur peut le faire.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            try {
              const action = command === 'promote' ? 'promote' : command === 'demote' ? 'demote' : 'remove';
              await sock.groupParticipantsUpdate(sender, [target], action);
              console.log(`Action ${action} exécutée: target=${target}, group=${sender}`);
              await sock.sendMessage(sender, { text: `✅ Utilisateur ${action === 'remove' ? 'retiré' : action === 'promote' ? 'promu admin' : 'rétrogradé'}.` });
              await reactToMessage(sock, sender, msg.key.id, '✅');
            } catch (err) {
              console.error(`Erreur lors de ${command}:`, err.message, err.stack);
              if (err.message === 'forbidden' || err.data === 403) {
                await sock.sendMessage(sender, { text: `❌ Je dois être administrateur du groupe pour exécuter ${command}.` });
              } else {
                await sock.sendMessage(sender, { text: `❌ Impossible d'exécuter ${command}. Erreur inattendue.` });
              }
              await reactToMessage(sock, sender, msg.key.id, '❌');
            }
            break;
          case 'add':
            console.log(`Commande .add reçue: sender=${sender}, group=${isGroup}, participant=${participant}, args=${args}`);
            if (!isGroup) {
              await sock.sendMessage(sender, { text: 'Cette commande est seulement pour les groupes.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: 'Seuls les admins peuvent utiliser cette commande.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (!args) {
              await sock.sendMessage(sender, { text: 'Utilisez : .add <numéro> (format international sans +)' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            const number = args.replace(/\D/g, '') + '@s.whatsapp.net';
            try {
              await sock.groupParticipantsUpdate(sender, [number], 'add');
              console.log(`Membre ajouté: number=${number}, group=${sender}`);
              await sock.sendMessage(sender, { text: `✅ Membre ${args} ajouté.` });
              await reactToMessage(sock, sender, msg.key.id, '✅');
            } catch (err) {
              console.error('Erreur lors de l\'ajout:', err.message, err.stack);
              if (err.message === 'forbidden' || err.data === 403) {
                await sock.sendMessage(sender, { text: '❌ Je dois être administrateur du groupe pour ajouter un membre.' });
              } else {
                await sock.sendMessage(sender, { text: '❌ Impossible d\'ajouter le membre. Erreur inattendue.' });
              }
              await reactToMessage(sock, sender, msg.key.id, '❌');
            }
            break;
          case 'tagall':
            if (!isGroup) {
              await sock.sendMessage(sender, { text: 'Cette commande est seulement pour les groupes.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: 'Seuls les admins peuvent utiliser cette commande.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            const participants = metadata.participants.map(p => p.id);
            await sock.sendMessage(sender, { text: args || '🔔 Tag all !', mentions: participants });
            await reactToMessage(sock, sender, msg.key.id, '🔔');
            break;
          case 'hidetag':
            if (!isGroup) {
              await sock.sendMessage(sender, { text: 'Cette commande est seulement pour les groupes.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: 'Seuls les admins peuvent utiliser cette commande.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            const participantsHide = metadata.participants.map(p => p.id);
            await sock.sendMessage(sender, { text: args || '🔕 Message du propriétaire', mentions: participantsHide });
            await reactToMessage(sock, sender, msg.key.id, '🔕');
            break;
          case 'kickall':
            if (!isGroup) {
              await sock.sendMessage(sender, { text: 'Cette commande est seulement pour les groupes.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (sender !== CREATOR_CONTACT) {
              await sock.sendMessage(sender, { text: 'Seul le propriétaire peut utiliser cette commande.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (!isBotAdmin) {
              await sock.sendMessage(sender, { text: 'Je dois être admin pour effectuer cette action.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            const nonAdmins = metadata.participants.filter(p => !p.admin && p.id !== botJid).map(p => p.id);
            if (nonAdmins.length > 0) {
              try {
                await sock.groupParticipantsUpdate(sender, nonAdmins, 'remove');
                await sock.sendMessage(sender, { text: '✅ Tous les non-admins ont été retirés.' });
                await reactToMessage(sock, sender, msg.key.id, '✅');
              } catch (err) {
                console.error('Erreur lors du kickall:', err.message);
                await sock.sendMessage(sender, { text: '❌ Erreur lors du retrait des membres.' });
                await reactToMessage(sock, sender, msg.key.id, '❌');
              }
            } else {
              await sock.sendMessage(sender, { text: 'Aucun non-admin à retirer.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
            }
            break;
          case 'alive':
            await reactToMessage(sock, sender, msg.key.id, '✅');
            await sock.sendMessage(sender, {
              image: { url: './images/alive.jpg' },
              caption: `🌟 Salut ! Aquila Bot est en ligne 🤖💬, prêt à répondre à tes questions et à t'amuser 😎💥. Ton assistant fidèle et un peu sarcastique 😏🖤 est prêt à agir ! 🚀`
            });
            break;
          case 'react':
            if (!args) {
              await sock.sendMessage(sender, { text: 'Utilisez : .react <emoji>' });
              break;
            }
            await reactToMessage(sock, sender, msg.key.id, args);
            break;
          case 'laugh':
            try {
              const audioBuffer = fs.readFileSync(LAUGH_AUDIO);
              await sock.sendMessage(sender, { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus' });
              await reactToMessage(sock, sender, msg.key.id, '😂');
            } catch (err) {
              console.error('Erreur envoi audio laugh:', err.message);
              await sock.sendMessage(sender, { text: 'Erreur lors de l\'envoi de l\'audio.' });
            }
            break;
          case 'cry':
            try {
              const audioBuffer = fs.readFileSync(CRY_AUDIO);
              await sock.sendMessage(sender, { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus' });
              await reactToMessage(sock, sender, msg.key.id, '😢');
            } catch (err) {
              console.error('Erreur envoi audio cry:', err.message);
              await sock.sendMessage(sender, { text: 'Erreur lors de l\'envoi de l\'audio.' });
            }
            break;
          case 'applaud':
            try {
              const audioBuffer = fs.readFileSync(APPLAUD_AUDIO);
              await sock.sendMessage(sender, { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus' });
              await reactToMessage(sock, sender, msg.key.id, '👏');
            } catch (err) {
              console.error('Erreur envoi audio applaud:', err.message);
              await sock.sendMessage(sender, { text: 'Erreur lors de l\'envoi de l\'audio.' });
            }
            break;
          case 'dorian':
            try {
              const imageBuffer = fs.readFileSync(THUMBSUP_IMAGE);
              const stickerBuffer = await convertToSticker(imageBuffer);
              await sock.sendMessage(sender, { sticker: stickerBuffer });
              await reactToMessage(sock, sender, msg.key.id, '👍');
            } catch (err) {
              console.error('Erreur envoi sticker thumbsup:', err.message);
              await sock.sendMessage(sender, { text: 'Erreur lors de l\'envoi du sticker.' });
            }
            break;
          case 'gloglo':
            try {
              const imageBuffer = fs.readFileSync(LOL_IMAGE);
              const stickerBuffer = await convertToSticker(imageBuffer);
              await sock.sendMessage(sender, { sticker: stickerBuffer });
              await reactToMessage(sock, sender, msg.key.id, '😆');
            } catch (err) {
              console.error('Erreur envoi sticker lol:', err.message);
              await sock.sendMessage(sender, { text: 'Erreur lors de l\'envoi du sticker.' });
            }
            break;
          case 'zi':
            try {
              const imageBuffer = fs.readFileSync(SAD_IMAGE);
              const stickerBuffer = await convertToSticker(imageBuffer);
              await sock.sendMessage(sender, { sticker: stickerBuffer });
              await reactToMessage(sock, sender, msg.key.id, '😔');
            } catch (err) {
              console.error('Erreur envoi sticker sad:', err.message);
              await sock.sendMessage(sender, { text: 'Erreur lors de l\'envoi du sticker.' });
            }
            break;
          case 'restart':
          case 'update':
          case 'broadcast':
            if (participant !== CREATOR_JID) {
              await sock.sendMessage(sender, { text: '❌ Commande réservée au propriétaire.' });
              await reactToMessage(sock, sender, msg.key.id, '❌');
              break;
            }
            if (command === 'restart') {
              await sock.sendMessage(sender, { text: 'Redémarrage en cours...' });
              process.exit(0);
            } else if (command === 'update') {
              await sock.sendMessage(sender, { text: 'Mise à jour en cours...' });
            } else if (command === 'broadcast') {
              const numbers = process.env.BROADCAST_NUMBERS ? process.env.BROADCAST_NUMBERS.split(',') : [];
              if (!args && numbers.length === 0) {
                await sock.sendMessage(sender, { text: 'Utilisez : .broadcast <message> ou configurez BROADCAST_NUMBERS.' });
                break;
              }
              const broadcastMessage = args || process.env.BROADCAST_MESSAGE || 'Message de broadcast par défaut.';
              for (const number of numbers) {
                const jid = number.trim() + '@s.whatsapp.net';
                await sock.sendMessage(jid, { text: broadcastMessage });
              }
              await sock.sendMessage(sender, { text: 'Broadcast envoyé !' });
            }
            await reactToMessage(sock, sender, msg.key.id, '🔒');
            break;
          default:
            await reactToMessage(sock, sender, msg.key.id, '❓');
            await sock.sendMessage(sender, { text: `Commande inconnue. Tapez *${PREFIX}help* pour voir les commandes.` });
        }
      });
      return;
    }

    if (text) {
      const geminiReply = await askGemini(text, sender);
      await sock.sendMessage(sender, { text: geminiReply });
    }
  });

  // Gestion des événements d'entrée et de sortie des participants dans un groupe (vérification par groupe)
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    console.log(`Événement group-participants.update: group=${id}, action=${action}, participants=${JSON.stringify(participants)}`);
    const welcomeEnabled = await getGroupSetting(id, 'welcome');
    if (!welcomeEnabled) return;
    try {
      // Récupérer les métadonnées du groupe pour le nombre de membres et d'admins
      const metadata = await retryOperation(() => sock.groupMetadata(id));
      const totalMembers = metadata.participants.length;
      const totalAdmins = metadata.participants.filter(p => p.admin).length;

      for (const participant of participants) {
        let imageOptions = {};
        try {
          // Tenter de récupérer la photo de profil de l'utilisateur
          const profilePicUrl = await sock.profilePictureUrl(participant, 'image');
          const response = await axios.get(profilePicUrl, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
          imageOptions = { image: Buffer.from(response.data) };
        } catch (err) {
          console.error(`Erreur lors de la récupération de la photo de profil pour ${participant}:`, err.message);
          // Utiliser l'image par défaut si la photo de profil n'est pas disponible
          imageOptions = { image: { url: DEFAULT_PROFILE_IMAGE } };
        }

        if (action === 'add') {
          // Message de bienvenue avec photo de profil (ou image par défaut), mention, et stats du groupe
          await sock.sendMessage(id, {
            ...imageOptions,
            caption: `🎉 Bienvenue @${participant.split('@')[0]} dans le groupe ! 😎\n` +
                    `Amuse-toi et tape .help pour découvrir mes commandes !\n` +
                    `📊 Nombre total de membres : ${totalMembers}\n` +
                    `👑 Nombre d'admins : ${totalAdmins}`,
            mentions: [participant]
          });
          console.log(`Message de bienvenue envoyé à ${participant} dans le groupe ${id}`);
        } else if (action === 'remove') {
          // Message d'au revoir avec photo de profil (ou image par défaut), mention, et stats du groupe
          await sock.sendMessage(id, {
            ...imageOptions,
            caption: `👋 @${participant.split('@')[0]} a quitté le groupe. À bientôt peut-être ! 😢\n` +
                    `📊 Nombre total de membres : ${totalMembers}\n` +
                    `👑 Nombre d'admins : ${totalAdmins}`,
            mentions: [participant]
          });
          console.log(`Message d'au revoir envoyé pour ${participant} dans le groupe ${id}`);
        }
      }
    } catch (err) {
      console.error(`Erreur lors de l'envoi du message ${action === 'add' ? 'de bienvenue' : 'd\'au revoir'}:`, err.message, err.stack);
      // Ne pas envoyer de message d'erreur dans le groupe pour éviter de spammer
    }
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('QR code généré. Scannez avec WhatsApp :');
      QRCode.toString(qr, { type: 'terminal' }, (err, url) => err ? console.error(err) : console.log(url));
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode || 'unknown';
      console.log('Déconnecté:', reason);
      if (reason !== DisconnectReason.loggedOut) setTimeout(startBot, 5000);
      else console.log('Déconnecté (logged out). Supprimez auth_info et relancez.');
    } else if (connection === 'open') {
      console.log('Connecté à WhatsApp!');
      sock.sendMessage(CREATOR_CONTACT, { text: 'Mon créateur, je suis en ligne 🙂‍↔️🥺🥹🥺' });
      setInterval(async () => {
        try {
          await sock.sendMessage(CREATOR_CONTACT, { text: 'Bot status: Online et opérationnel !' });
        } catch (err) {
          console.error('Erreur message périodique:', err.message);
        }
      }, 600000);
    }
  });

  return sock;
}

module.exports = startBot;