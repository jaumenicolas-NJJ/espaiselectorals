// Función de Netlify: atiende /api/* y guarda los datos en Netlify Blobs (región de Frankfurt).
import { getStore } from '@netlify/blobs';
import { makeHandler } from './core.mjs';

const envGet = (k) => (globalThis.Netlify && Netlify.env && Netlify.env.get(k)) || process.env[k] || '';

export default async (req) => {
  // El almacén se crea en cada petición: el permiso temporal de Blobs caduca si se reutiliza.
  const handler = makeHandler({
    store: getStore({ name: 'espais', consistency: 'strong', region: 'eu-central-1' }),
    env: { ESPAIS_CLAVE_INICIAL: envGet('ESPAIS_CLAVE_INICIAL'), ESPAIS_SECRET: envGet('ESPAIS_SECRET') }
  });
  return handler(req);
};

export const config = { path: '/api/*' };
