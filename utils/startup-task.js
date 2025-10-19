const { execFile } = require("child_process");

const TASK_NAME = "AchievementsAutoStart";

function runSchtasks(args) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "schtasks.exe",
      args,
      { windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

async function hasStartupTask() {
  try {
    await runSchtasks(["/Query", "/TN", TASK_NAME]);
    return true;
  } catch {
    return false;
  }
}

async function createStartupTask(commandLine) {
  await runSchtasks([
    "/Create",
    "/TN",
    TASK_NAME,
    "/TR",
    commandLine,
    "/SC",
    "ONLOGON",
    "/RL",
    "HIGHEST",
    "/F",
  ]);
}

async function deleteStartupTask() {
  await runSchtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
}

module.exports = { hasStartupTask, createStartupTask, deleteStartupTask };
