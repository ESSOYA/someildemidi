require('dotenv').config();

module.exports = {
    SESSION_DIR: process.env.SESSION_DIR || './auth_info',
    CREATOR_CONTACT: 'https://wa.me/+24166813542',
    PREFIX: '.',
    MENU_IMAGE_PATH: './images/menu.jpg',
    MENU_VIDEO_PATH: './videos/menu.mp4',
    CACHE_TIMEOUT: 10000,
    forbiddenWords: ['insulte', 'offensive', 'inapproprié']
};
