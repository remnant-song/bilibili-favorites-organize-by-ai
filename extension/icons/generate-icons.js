// generate-icons.js - Generate PNG icons for the extension
// Run: node generate-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Ensure we're in the icons directory
const iconsDir = __dirname;
const sizes = [16, 48, 128];

// Create a simple PNG with a colored circle and "AI" text
function createPNG(size) {
    // PNG signature
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    // IHDR chunk
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(size, 0);  // width
    ihdrData.writeUInt32BE(size, 4); // height
    ihdrData.writeUInt8(8, 8);        // bit depth
    ihdrData.writeUInt8(6, 9);        // color type (RGBA)
    ihdrData.writeUInt8(0, 10);       // compression
    ihdrData.writeUInt8(0, 11);       // filter
    ihdrData.writeUInt8(0, 12);       // interlace

    const ihdrChunk = createChunk('IHDR', ihdrData);

    // IDAT chunk - raw pixel data
    const rawData = [];

    // B站粉色 #fb7299
    const r = 251, g = 114, b = 153, a = 255;
    const center = size / 2;
    const radius = (size / 2) - 1;

    for (let y = 0; y < size; y++) {
        rawData.push(0); // filter byte
        for (let x = 0; x < size; x++) {
            const dx = x - center;
            const dy = y - center;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist <= radius) {
                // Inside circle - pink background
                rawData.push(r, g, b, a);
            } else {
                // Outside circle - transparent
                rawData.push(0, 0, 0, 0);
            }
        }
    }

    const compressed = zlib.deflateSync(Buffer.from(rawData));
    const idatChunk = createChunk('IDAT', compressed);

    // IEND chunk
    const iendChunk = createChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    const typeBuffer = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeBuffer, data]);

    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcData), 0);

    return Buffer.concat([length, typeBuffer, data, crc]);
}

// CRC32 calculation
function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    const table = makeCRCTable();

    for (let i = 0; i < buffer.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xFF];
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeCRCTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            if (c & 1) {
                c = 0xEDB88320 ^ (c >>> 1);
            } else {
                c = c >>> 1;
            }
        }
        table[n] = c;
    }
    return table;
}

// Generate icons
console.log('Generating icons...');

for (const size of sizes) {
    const png = createPNG(size);
    const filename = path.join(iconsDir, `icon-${size}.png`);
    fs.writeFileSync(filename, png);
    console.log(`Created: icon-${size}.png (${png.length} bytes)`);
}

console.log('Done!');
