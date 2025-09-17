

require('dotenv').config();
const axios = require('axios');

// Recherche Google classique
async function googleSearch(query) {
    try {
        const apiKey = process.env.GOOGLE_API_KEY;
        const cx = process.env.GOOGLE_CX;
        const res = await axios.get('https://www.googleapis.com/customsearch/v1', {
            params: { key: apiKey, cx, q: query, hl: 'fr' }
        });
        if (res.data.items && res.data.items.length > 0) {
            const top = res.data.items[0];
            return `${top.title}\n${top.snippet}\nSource: ${top.link}`;
        }
        return 'Aucun résultat trouvé.';
    } catch (err) {
        console.error(err);
        return 'Erreur Google Search.';
    }
}

// Recherche d'image Google
async function googleImageSearch(query) {
    try {
        const apiKey = process.env.GOOGLE_API_KEY;
        const cx = process.env.GOOGLE_CX;

        if (!apiKey || !cx) {
            console.error('Erreur : GOOGLE_API_KEY ou GOOGLE_CX manquant !');
            return null;
        }

        const res = await axios.get('https://www.googleapis.com/customsearch/v1', {
            params: { key: apiKey, cx, searchType: 'image', q: query, num: 1 },
        });

        if (res.data.items && res.data.items.length > 0) {
            return res.data.items[0].link;
        }
        return null;
    } catch (err) {
        if (err.response && err.response.status === 403) {
            console.error('Erreur 403 : Vérifie ta clé API, ton CX et ton quota.');
        } else {
            console.error(err);
        }
        return null;
    }
}

module.exports = { googleSearch, googleImageSearch };
