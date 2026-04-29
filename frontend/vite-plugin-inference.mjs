// ─── Vite plugin: inline inference API ──────────────────
// Handles /api/render directly in Vite dev server.
// No separate bridge server needed.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

const TMP_DIR = join(import.meta.dirname, '..', 'tmp');

export default function inferencePlugin() {
  return {
    name: 'synthdiff-inference',
    configureServer(server) {
      if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR);

      server.middlewares.use('/api/render', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end('POST only');
        }

        try {
          // Read body
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const { notes, bpm, voicebank, speaker } = body;

          if (!notes || notes.length === 0) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ error: 'No notes provided' }));
          }

          // Write temp project file
          const projFile = join(TMP_DIR, `proj_${Date.now()}.json`);
          writeFileSync(projFile, JSON.stringify({ notes, bpm, voicebank, speaker }, null, 2));

          const outFile = projFile.replace('.json', '.wav');
          const renderScript = join(import.meta.dirname, '..', 'render-project.mjs');
          const cwd = join(import.meta.dirname, '..');

          // Run render
          const child = spawn('node', [
            renderScript, projFile, outFile,
            voicebank || 'Netriko_Nakayama_AI_v100',
            speaker || 'standard',
          ], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

          let stderr = '';
          child.stderr.on('data', d => stderr += d.toString());

          child.on('close', (code) => {
            if (code !== 0 || !existsSync(outFile)) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({
                error: `Render failed (code ${code})`,
                detail: stderr.slice(-500),
              }));
            }

            const wavBuf = readFileSync(outFile);
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Length', wavBuf.length);
            res.end(wavBuf);
          });

          child.on('error', (err) => {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message }));
          });
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      // Health check
      server.middlewares.use('/api/health', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
      });
    },
  };
}
