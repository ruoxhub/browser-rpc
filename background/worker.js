// Chrome MV3 runs this file as a module worker (manifest.background.type = "module"),
// so the background dependencies are static imports instead of runtime script fetches.
//
// The previous classic-worker approach fetched each sibling script at runtime through the
// chrome-extension:// scheme. On worker (re)start that fetch could fail with
// "Uncaught NetworkError ... An unknown error occurred when fetching the script", which
// aborted the whole background context. Static imports are resolved by the module loader
// at registration time, so there is no per-start fetch race.
//
// ESM gives each file its own scope, which is safe here: modules are fully IIFE/UMD-wrapped
// and export through globalThis during module evaluation, before this file's imports finish
// and before background.js runs.
//
// Firefox 128+ ignores service_worker/type and loads background.scripts in order as
// classic scripts, so both browsers keep the same load order.
import './rpc-manager.js';
import './modules/input-readiness.js';
import './modules/agent-session.js';
import './modules/vom-engine.js';
import './modules/long-screenshot.js';
import './modules/human-loop.js';
import './modules/file-transfer.js';
import './modules/devtools-collector.js';
import './modules/debugger-manager.js';
import './modules/network-module.js';
import './browser/utils.js';
import './browser/cdp.js';
import './browser/tabs.js';
import './browser/cookies.js';
import './browser/scripting.js';
import './browser/interaction.js';
import './browser/devtools.js';
import './browser/debugger.js';
import './browser/network.js';
import './browser/agent.js';
import './browser/dom.js';
import './browser-actions.js';
import './background.js';
