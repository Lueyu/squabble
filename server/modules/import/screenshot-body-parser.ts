import { json, urlencoded, type RequestHandler } from 'express';

/** Keep the ordinary API limit small while allowing an 8MiB base64 image upload. */
export function screenshotBodyParser(): RequestHandler {
  const parse = json({ limit: '12mb' });
  return (req, res, next) => {
    if (req.method === 'POST' && (['/api/import/screenshot-jobs', '/api/import/ocr/extract', '/api/data-library/files'].includes(req.path)
      || /^\/api\/import\/batches\/[0-9a-f-]{36}\/images(?:\/[0-9a-f-]{36}\/reselect)?$/i.test(req.path))) parse(req, res, next);
    else next();
  };
}

/** Use one Express/body-parser version; Nest's bundled parser cannot reread its stream. */
export function importBodyParsers(): RequestHandler[] {
  return [screenshotBodyParser(), json({ limit: '1mb' }), urlencoded({ limit: '1mb', extended: true })];
}
