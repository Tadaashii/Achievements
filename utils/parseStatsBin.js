// utils/parseStatsBin.js
const fs = require('fs');

function bufferSplitIntoChunks(buffer, n) {
    const result = [];
    for (let i = 0; i < buffer.length; i += n) {
        result.push(buffer.slice(i, i + n));
    }
    return result;
}

function parseStatsBin(filePath) {
    const buffer = fs.readFileSync(filePath);

    const header = buffer.slice(0, 4);
    const expectedStatsCount = header.readInt32LE(0);

    const chunkLength = 24;
    const chunks = bufferSplitIntoChunks(buffer.slice(4), chunkLength);

    if (chunks.length !== expectedStatsCount) {
        throw new Error("Unexpected stats count in stats.bin");
    }

    const achievements = {};

    for (const chunk of chunks) {
        try {
            const crc = chunk.slice(0, 4).reverse().toString('hex');
            const unlockTime = chunk.slice(8, 12).readInt32LE();
            const achieved = chunk.slice(20, 24).readInt32LE();

            if (achieved <= 1) {
                achievements[crc] = {
                    earned: achieved === 1,
                    earned_time: unlockTime
                };
            }
        } catch (e) {
            continue;
        }
    }

    return achievements;
}

module.exports = parseStatsBin;
