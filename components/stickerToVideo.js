const { downloadContentFromMessage } = require('baileys');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');

async function stickerToVideo(sock, sender, quoted) {
    if (!quoted || !quoted.stickerMessage || !quoted.stickerMessage.isAnimated) {
        console.log('Aucun sticker animé cité pour -video');
        await sock.sendMessage(sender, { text: 'Veuillez citer un sticker animé pour le convertir en vidéo.' });
        return;
    }
    try {
        const stream = await downloadContentFromMessage(quoted.stickerMessage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        const inputPath = path.join(os.tmpdir(), `sticker_${Date.now()}.webp`);
        const outputPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
        fs.writeFileSync(inputPath, buffer);

        const ffmpegCmd = `ffmpeg -i ${inputPath} -vcodec libx264 -pix_fmt yuv420p ${outputPath}`;

        await new Promise((resolve, reject) => {
            exec(ffmpegCmd, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        const videoBuffer = fs.readFileSync(outputPath);
        await sock.sendMessage(sender, { video: videoBuffer, mimetype: 'video/mp4' });

        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
    } catch (err) {
        console.error('Erreur lors de la conversion en vidéo:', err.message);
        await sock.sendMessage(sender, { text: 'Impossible de convertir le sticker en vidéo.' });
    }
}

module.exports = { stickerToVideo };