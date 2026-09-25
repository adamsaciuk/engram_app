/*
 * Start with Windows via a per-user Scheduled Task named "Engram" (logon
 * trigger, 20 s delay, no time limit). A task records its last run and
 * result in Task Scheduler, where an HKCU Run entry that dies early leaves
 * no trace. Default ON for an installed Engram (D-A974: installing it
 * puts it in the tray and turns it on at startup); the first packaged run
 * registers the task once, and the person's choice from the menu is
 * remembered in userData/settings.json from then on.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const TASK = 'Engram';
let electronApp = null;
let state = false;

function settingsFile() {
    return path.join(electronApp.getPath('userData'), 'settings.json');
}
function readSettings() {
    try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, 2) + '\n', 'utf8');
}

function runPs(script, done) {
    if (process.platform !== 'win32') { done && done(new Error('not windows')); return; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => done && done(err, stdout));
}

function registerScript() {
    const argument = electronApp.isPackaged ? '--autostart' : `"${path.join(__dirname, '..')}" --autostart`;
    return [
        `$act = New-ScheduledTaskAction -Execute '${process.execPath}' -Argument '${argument}'`,
        `$trig = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
        `$trig.Delay = 'PT20S'`,
        `$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)`,
        `Register-ScheduledTask -TaskName '${TASK}' -Action $act -Trigger $trig -Settings $set -RunLevel Limited -Force | Out-Null`,
    ].join('; ');
}

/** Read the task's presence once at boot so the menu can be built synchronously. */
function load(app, done) {
    electronApp = app;
    if (process.platform !== 'win32') return;
    execFile('schtasks', ['/Query', '/TN', TASK], { windowsHide: true }, (err) => {
        state = !err;
        // an installed Engram turns itself on at startup the first time it runs; the menu can turn it off
        if (!state && app.isPackaged && readSettings().autoStart === undefined) setEnabled(true, done);
        else if (done) done();
    });
}

function current() {
    return state;
}

function setEnabled(on, done) {
    writeSettings({ autoStart: on });
    if (on) {
        runPs(registerScript(), (err) => { state = !err; done && done(); });
    } else {
        runPs(`Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false`, () => { state = false; done && done(); });
    }
}

module.exports = { load, current, setEnabled };
