

    const fs = require('fs');
    const path = require('path');
    const gTTS = require('gtts');
    const ffmpeg = require('fluent-ffmpeg');

    async function textToAudio(text, lang = 'fr') {
        return new Promise((resolve, reject) => {
            try {
                const tmpMp3 = path.join(__dirname, `tts_${Date.now()}.mp3`);
                const tmpOgg = path.join(__dirname, `tts_${Date.now()}.ogg`);
                const gtts = new gTTS(text, lang);

                gtts.save(tmpMp3, function (err) {
                    if (err) return reject(err);

                    // Conversion MP3 -> OGG Opus
                    ffmpeg(tmpMp3)
                        .audioCodec('libopus')
                        .format('ogg')
                        .on('end', () => {
                            const buffer = fs.readFileSync(tmpOgg);
                            fs.unlinkSync(tmpMp3);
                            fs.unlinkSync(tmpOgg);
                            resolve(buffer);
                        })
                        .on('error', (err) => reject(err))
                        .save(tmpOgg);
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    module.exports = { textToAudio };
