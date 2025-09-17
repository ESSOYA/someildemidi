// const { downloadContentFromMessage } = require('baileys');
// const fs = require('fs');
// const { exec } = require('child_process');
// const path = require('path');
// const os = require('os');

// async function mediaToSticker(sock, sender, quoted) {
//     if (!quoted) {
//         console.log('Aucun message cité pour -sticker');
//         await sock.sendMessage(sender, { text: 'Veuillez citer une image ou une vidéo courte pour la convertir en sticker.' });
//         return;
//     }
//     console.log('Message cité:', JSON.stringify(quoted, null, 2));

//     const isImage = quoted.imageMessage || (quoted.documentMessage && quoted.documentMessage.mimetype.startsWith('image/'));
//     const isVideo = quoted.videoMessage || (quoted.documentMessage && quoted.documentMessage.mimetype.startsWith('video/'));

//     if (!isImage && !isVideo) {
//         await sock.sendMessage(sender, { text: 'Le message cité n’est pas une image ou une vidéo courte valide.' });
//         return;
//     }

//     try {
//         const mediaType = isImage ? 'image' : 'video';
//         const stream = await downloadContentFromMessage(isImage ? (quoted.imageMessage || quoted.documentMessage) : (quoted.videoMessage || quoted.documentMessage), mediaType);
//         let buffer = Buffer.from([]);
//         for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

//         const inputPath = path.join(os.tmpdir(), `input_${Date.now()}.${isImage ? 'jpg' : 'mp4'}`);
//         const outputPath = path.join(os.tmpdir(), `sticker_${Date.now()}.webp`);
//         fs.writeFileSync(inputPath, buffer);

//         let ffmpegCmd;
//         if (isImage) {
//             ffmpegCmd = `ffmpeg -i ${inputPath} -vf scale=512:512 ${outputPath}`;
//         } else {
//             ffmpegCmd = `ffmpeg -i ${inputPath} -vcodec libwebp -filter:v fps=fps=15 -loop 0 -preset default -an -vsync 0 -s 512:512 ${outputPath}`;
//         }

//         await new Promise((resolve, reject) => {
//             exec(ffmpegCmd, (err) => {
//                 if (err) reject(err);
//                 else resolve();
//             });
//         });

//         const stickerBuffer = fs.readFileSync(outputPath);
//        await sock.sendMessage(sender, { 
//     sticker: stickerBuffer, 
//     isAnimated: isVideo, 
//     stickerMetadata: { 
//         pack: 'AquilBot', 
//         author: 'LE PRINCE MYENE' 
//     } 
// });


//         fs.unlinkSync(inputPath);
//         fs.unlinkSync(outputPath);
//     } catch (err) {
//         console.error('Erreur lors de la conversion en sticker:', err.message);
//         await sock.sendMessage(sender, { text: 'Impossible de convertir en sticker. Assurez-vous que la vidéo est courte (< 8 secondes) et que FFmpeg est installé.' });
//     }
// }

// module.exports = { mediaToSticker };



const { downloadContentFromMessage } = require('baileys');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');

// Constantes pour les métadonnées du sticker
const STICKER_PACK = 'AquilBot';
const STICKER_AUTHOR = 'LE PRINCE MYENE';

async function mediaToSticker(sock, sender, quoted) {
    if (!quoted) {
        console.log('Aucun message cité pour .sticker');
        await sock.sendMessage(sender, { text: 'Veuillez citer une image ou une vidéo courte pour la convertir en sticker.' });
        return;
    }
    console.log('Message cité:', JSON.stringify(quoted, null, 2));

    const isImage = quoted.imageMessage || (quoted.documentMessage && quoted.documentMessage.mimetype.startsWith('image/'));
    const isVideo = quoted.videoMessage || (quoted.documentMessage && quoted.documentMessage.mimetype.startsWith('video/'));

    if (!isImage && !isVideo) {
        await sock.sendMessage(sender, { text: 'Le message cité n’est pas une image ou une vidéo courte valide.' });
        return;
    }

    let inputPath;
    let outputPath;

    try {
        const mediaType = isImage ? 'image' : 'video';
        const stream = await downloadContentFromMessage(isImage ? (quoted.imageMessage || quoted.documentMessage) : (quoted.videoMessage || quoted.documentMessage), mediaType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        inputPath = path.join(os.tmpdir(), `input_${Date.now()}.${isImage ? 'jpg' : 'mp4'}`);
        outputPath = path.join(os.tmpdir(), `sticker_${Date.now()}.webp`);
        fs.writeFileSync(inputPath, buffer);

        // Commande FFmpeg pour la conversion
        const ffmpegCmd = isImage
            ? `ffmpeg -i ${inputPath} -vf scale=512:512 -c:v libwebp -lossless 1 -q:v 100 -preset default ${outputPath}`
            : `ffmpeg -i ${inputPath} -vcodec libwebp -filter:v fps=fps=15 -lossless 1 -loop 0 -preset default -an -vsync 0 -s 512:512 ${outputPath}`;

        console.log(`Exécution de la commande FFmpeg : ${ffmpegCmd}`);
        await new Promise((resolve, reject) => {
            exec(ffmpegCmd, (err, stdout, stderr) => {
                if (err) {
                    console.error('Erreur FFmpeg:', stderr);
                    reject(new Error(`Échec de la conversion FFmpeg : ${stderr}`));
                } else {
                    console.log('Conversion FFmpeg réussie');
                    resolve();
                }
            });
        });

        const stickerBuffer = fs.readFileSync(outputPath);
        console.log('Envoi du sticker avec métadonnées:', {
            pack: STICKER_PACK,
            author: STICKER_AUTHOR,
            isAnimated: isVideo
        });

        // Envoi du sticker avec métadonnées
        await sock.sendMessage(sender, {
            sticker: stickerBuffer,
            isAnimated: isVideo,
            packname: STICKER_PACK, // Format alternatif pour les métadonnées
            author: STICKER_AUTHOR
        });

        await sock.sendMessage(sender, { text: `Sticker envoyé ! Package: ${STICKER_PACK}, Auteur: ${STICKER_AUTHOR}` });

    } catch (err) {
        console.error('Erreur lors de la conversion en sticker:', err.message);
        await sock.sendMessage(sender, { text: `Impossible de convertir en sticker : ${err.message}. Assurez-vous que la vidéo est courte (< 8 secondes) et que FFmpeg est installé.` });
    } finally {
        // Nettoyage des fichiers temporaires
        if (inputPath && fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
            console.log(`Fichier temporaire supprimé : ${inputPath}`);
        }
        if (outputPath && fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
            console.log(`Fichier temporaire supprimé : ${outputPath}`);
        }
    }
}

module.exports = { mediaToSticker };