import { USER_AGENT } from '../net/download.js';

const MODRINTH = 'https://api.modrinth.com/v2';
const COOLDOWN_MS = 60 * 1000;
let lastSentAt = 0;

/** Recherche de mods Forge compatibles 1.20.1 sur Modrinth. */
export async function searchMods(query, { mcVersion = '1.20.1', loader = 'forge' } = {}) {
  const facets = JSON.stringify([[`categories:${loader}`], [`versions:${mcVersion}`], ['project_type:mod']]);
  const url = `${MODRINTH}/search?${new URLSearchParams({ query, facets, limit: '20', index: 'relevance' })}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Recherche Modrinth impossible (HTTP ${res.status})`);
  const data = await res.json();
  return data.hits.map((h) => ({
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    downloads: h.downloads,
    icon: h.icon_url || null,
    url: `https://modrinth.com/mod/${h.slug}`,
    clientSide: h.client_side,
    serverSide: h.server_side,
  }));
}

/**
 * Envoie une suggestion de mod sur le salon Discord de l'équipe (webhook).
 * suggestion: { title, url, reason, player }
 */
export async function sendSuggestion(webhookUrl, { title, url, reason, player }) {
  if (!webhookUrl) throw new Error("L'envoi de suggestions n'est pas encore configuré par l'équipe.");
  if (!/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(webhookUrl)) {
    throw new Error('Adresse de webhook Discord invalide.');
  }
  const wait = lastSentAt + COOLDOWN_MS - Date.now();
  if (wait > 0) throw new Error(`Patiente encore ${Math.ceil(wait / 1000)} s avant d'envoyer une autre suggestion.`);

  const clean = (s, max) =>
    String(s ?? '')
      .replace(/@(everyone|here)/g, '@​$1')
      .slice(0, max);
  const body = {
    username: 'Launcher Pays de la Valière',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `💡 Suggestion de mod : ${clean(title, 200)}`,
        url: /^https?:\/\//.test(url || '') ? url : undefined,
        description: clean(reason, 1800) || '_Aucune précision_',
        color: 0xc2477a,
        footer: { text: `Proposé par ${clean(player, 32)}` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Envoi impossible (HTTP ${res.status}).`);
  lastSentAt = Date.now();
}
