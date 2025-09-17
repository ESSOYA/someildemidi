

// const { CohereClient } = require("cohere-ai");
// require("dotenv").config();

// const cohere = new CohereClient({ apiKey: process.env.CO_API_KEY });

// async function askCohere(message) {
//   try {
//     const response = await cohere.chat({
//       model: "command-xlarge-nightly",
//       message: message
//     });

//     // Check sécurisé de la réponse
//     const content = response?.output?.[0]?.content;
//     if (content) {
//       console.log("Réponse Cohere :", content);
//     } else {
//       console.log("Aucune réponse disponible :", response);
//     }

//   } catch (error) {
//     console.error("Erreur Cohere:", error);
//   }
// }

// askCohere("Salut, raconte-moi une blague courte !");










// const { CohereClient } = require("cohere-ai");
// require("dotenv").config();

// const cohere = new CohereClient({ apiKey: process.env.COHERE_API_KEYS });

// async function askCohere(message) {
//   try {
//     const response = await cohere.chat({
//       model: "command-xlarge-nightly",
//       message: message
//     });

//     // Affiche directement le texte généré
//     console.log("Réponse Cohere :", response.text);

//   } catch (error) {
//     console.error("Erreur Cohere:", error);
//   }
// }

// askCohere("Salut, comment vas-tu !");





const { CohereClient } = require("cohere-ai");
require("dotenv").config();

const keys = process.env.COHERE_API_KEYS.split(","); // sépare en tableau
const apiKey = keys[0].trim(); // prends la première clé

const cohere = new CohereClient({ apiKey });

async function askCohere(message) {
  try {
    const response = await cohere.chat({
      model: "command-xlarge-nightly",
      message: message,
    });

    console.log("Réponse Cohere :", response.text);

  } catch (error) {
    console.error("Erreur Cohere:", error);
  }
}

askCohere("Salut, comment vas-tu !");
