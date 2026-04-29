// ─── Inference Bridge Server ─────────────────────────────
// Bridges the React frontend (Vite) to the Node.js inference pipeline.
// Run: node frontend/server.mjs

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PORT = 3002;
const TMP_DIR = join(ROOT, 'tmp');

if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR);

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  // Render endpoint
  if (req.method === 'POST' && req.url === '/api/render') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { notes, bpm, voicebank, speaker } = body;

      if (!notes || notes.length === 0) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'No notes provided' }));
      }

      // Write project file
      const projFile = join(TMP_DIR, `proj_${Date.now()}.json`);
      writeFileSync(projFile, JSON.stringify({ notes, bpm, voicebank, speaker }, null, 2));

      // Run render as child process
      const outFile = projFile.replace('.json', '.wav');
      const renderScript = join(ROOT, 'render-project.mjs');

      const child = spawn('node', [renderScript, projFile, outFile, voicebank || 'Netriko_Nakayama_AI_v100', speaker || 'standard'], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      child.stdout.on('data', d => stdout += d.toString());

      child.on('error', (err) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      });

      child.on('close', (code) => {
        if (code !== 0 || !existsSync(outFile)) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: `Render failed (code ${code}): ${stdout.slice(-200)}` }));
          return;
        }

        const wavBuf = readFileSync(outFile);
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': wavBuf.length,
        });
        res.end(wavBuf);
      });
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Inference bridge ready on http://127.0.0.1:${PORT}`);
});
