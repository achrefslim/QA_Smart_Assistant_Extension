/**
 * build.mjs
 *
 * Builds the QA Smart Assistant TypeScript extension.
 *
 * Two modes:
 *   node build.mjs          → build once and exit
 *   node build.mjs --watch  → build once, then watch for changes and rebuild automatically
 */

import * as esbuild from 'esbuild';
import { promises as fs } from 'fs';
import path from 'path';

const SRC       = './src';
const DIST      = './dist';
const WATCH_MODE = process.argv.includes('--watch');

// ─── TypeScript entry points ──────────────────────────────────────────────────
// Each .ts file gets compiled to a .js file in dist/

const ENTRY_POINTS = [
  { in: `${SRC}/background/background.ts`,           out: 'background/background'   },
  { in: `${SRC}/content/content.ts`,                 out: 'content/content'         },
  { in: `${SRC}/controlbar/controlbar.ts`,           out: 'controlbar/controlbar'   },
  { in: `${SRC}/screens/popup/popup.ts`,             out: 'popup/popup'             },
  { in: `${SRC}/screens/recorder/recorder.ts`,       out: 'recorder/recorder'       },
  { in: `${SRC}/screens/review/review.ts`,           out: 'review/review'           },
  { in: `${SRC}/screens/permissions/permissions.ts`, out: 'permissions/permissions' },
  { in: `${SRC}/shared/db/database.ts`,              out: 'shared/db'               },
];

// ─── Static files (HTML, CSS, icons) — copied as-is, never compiled ──────────
// These live next to the compiled JS in dist/

const STATIC_FILES = [
  { from: './static/manifest.json',              to: 'manifest.json'                  },
  { from: './static/popup/popup.html',           to: 'popup/popup.html'               },
  { from: './static/popup/popup.css',            to: 'popup/popup.css'                },
  { from: './static/recorder/recorder.html',     to: 'recorder/recorder.html'         },
  { from: './static/recorder/recorder.css',      to: 'recorder/recorder.css'          },
  { from: './static/review/review.html',         to: 'review/review.html'             },
  { from: './static/review/review.css',          to: 'review/review.css'              },
  { from: './static/review/review-print.css',    to: 'review/review-print.css'        },
  { from: './static/permissions/permissions.html', to: 'permissions/permissions.html' },
  { from: './static/permissions/permissions.css',  to: 'permissions/permissions.css'  },
  { from: './static/controlbar/controlbar.css',  to: 'controlbar/controlbar.css'      },
  { from: './static/shared/jszip.min.js',        to: 'shared/jszip.min.js'            },
  { from: './static/assets/icons/icon16.png',    to: 'assets/icons/icon16.png'        },
  { from: './static/assets/icons/icon48.png',    to: 'assets/icons/icon48.png'        },
  { from: './static/assets/icons/icon128.png',   to: 'assets/icons/icon128.png'       },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function copyStaticFiles() {
  for (const file of STATIC_FILES) {
    try {
      const dest = path.join(DIST, file.to);
      await ensureDir(dest);
      await fs.copyFile(file.from, dest);
    } catch (e) {
      console.warn(`  ⚠  Could not copy ${file.from} — ${e.message}`);
    }
  }
}

// ─── Watch plugin — runs after every rebuild ──────────────────────────────────

const watchPlugin = {
  name: 'watch-notify',
  setup(build) {
    build.onEnd(result => {
      const time = new Date().toLocaleTimeString();
      if (result.errors.length > 0) {
        console.log(`\n❌ [${time}] Build failed — ${result.errors.length} error(s)`);
        result.errors.forEach(e => console.log(`   ${e.text}`));
      } else {
        console.log(`✓  [${time}] Rebuilt successfully — reload the extension in Chrome`);
      }
    });
  },
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Always do a clean build first
  console.log('🔨 QA Smart Assistant — TypeScript Build\n');
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  console.log('📂 Copying static assets (HTML, CSS, icons)...');
  await copyStaticFiles();
  console.log('   ✓ Static assets copied\n');

  const esbuildOptions = {
    entryPoints: ENTRY_POINTS,
    bundle     : true,
    outdir     : DIST,
    format     : 'iife',    // Chrome extensions require IIFE — not ES modules
    target     : 'es2020',
    sourcemap  : false,
    minify     : false,     // Keep readable so the QA team can inspect it
    platform   : 'browser',
    plugins    : [watchPlugin],
  };

  if (WATCH_MODE) {
    // Watch mode: rebuild automatically whenever a .ts file is saved
    console.log('👁  Watch mode ON — editing any .ts file will auto-rebuild\n');
    console.log('   To stop: press  Ctrl + C\n');
    const ctx = await esbuild.context(esbuildOptions);
    await ctx.watch();
    console.log('✓  Initial build complete — load the dist/ folder in Chrome\n');
    console.log('─'.repeat(55));
  } else {
    // One-shot build
    console.log('⚙  Compiling TypeScript...');
    await esbuild.build(esbuildOptions);
    console.log('   ✓ TypeScript compiled\n');
    console.log('✅ Build complete → dist/');
    console.log('   Load the dist/ folder in Chrome to run the extension.');
  }
}

main().catch(e => {
  console.error('❌ Build error:', e.message);
  process.exit(1);
});
