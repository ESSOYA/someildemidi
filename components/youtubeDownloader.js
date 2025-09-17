const ytdl = require('ytdl-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function downloadYouTube(sock, sender, url) {
    if (!ytdl.validateURL(url)) {
        await sock.sendMessage(sender, { text: 'URL YouTube invalide. Utilisez : -yt <url>' });
        return;
    }

    try {
        const info = await ytdl.getInfo(url);

        // Choisir un format contenant vidéo + audio
        const format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: f => f.hasAudio && f.hasVideo });
        if (!format) {
            await sock.sendMessage(sender, { text: 'Impossible de trouver une vidéo avec audio intégré sur YouTube.' });
            return;
        }

        const tempPath = path.join(os.tmpdir(), `yt_${Date.now()}.mp4`);
        await new Promise((resolve, reject) => {
            ytdl(url, { format })
                .pipe(fs.createWriteStream(tempPath))
                .on('finish', resolve)
                .on('error', reject);
        });

        const videoBuffer = fs.readFileSync(tempPath);
        await sock.sendMessage(sender, { video: videoBuffer, mimetype: 'video/mp4', caption: info.videoDetails.title });

        fs.unlinkSync(tempPath);

    } catch (err) {
        console.error('Erreur lors du téléchargement YouTube:', err.message);
        await sock.sendMessage(sender, { text: 'Impossible de télécharger la vidéo YouTube.' });
    }
}

module.exports = { downloadYouTube };
