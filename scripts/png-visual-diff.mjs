import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
	const name = Buffer.from(type, 'ascii');
	const chunk = Buffer.allocUnsafe(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	name.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
	return chunk;
}

function paeth(left, above, upperLeft) {
	const estimate = left + above - upperLeft;
	const leftDistance = Math.abs(estimate - left);
	const aboveDistance = Math.abs(estimate - above);
	const upperLeftDistance = Math.abs(estimate - upperLeft);
	return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
		? left
		: aboveDistance <= upperLeftDistance ? above : upperLeft;
}

export function decodePng(input) {
	const png = Buffer.from(input);
	if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('Invalid PNG signature.');
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const compressed = [];
	for (let offset = PNG_SIGNATURE.length; offset < png.length;) {
		const length = png.readUInt32BE(offset);
		const type = png.subarray(offset + 4, offset + 8).toString('ascii');
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
			if (data[12] !== 0) throw new Error('Interlaced PNG screenshots are not supported.');
		}
		if (type === 'IDAT') compressed.push(data);
		offset += length + 12;
		if (type === 'IEND') break;
	}
	if (!width || !height || bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType)) {
		throw new Error(`Unsupported PNG format: ${width}x${height}, depth ${bitDepth}, color type ${colorType}.`);
	}
	const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType];
	const stride = width * channels;
	const filtered = inflateSync(Buffer.concat(compressed));
	if (filtered.length !== (stride + 1) * height) throw new Error('PNG pixel data has an unexpected length.');
	const pixels = new Uint8Array(stride * height);
	for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
		const filter = filtered[rowIndex * (stride + 1)];
		const sourceOffset = rowIndex * (stride + 1) + 1;
		const targetOffset = rowIndex * stride;
		for (let column = 0; column < stride; column += 1) {
			const source = filtered[sourceOffset + column];
			const left = column >= channels ? pixels[targetOffset + column - channels] : 0;
			const above = rowIndex > 0 ? pixels[targetOffset + column - stride] : 0;
			const upperLeft = rowIndex > 0 && column >= channels
				? pixels[targetOffset + column - stride - channels]
				: 0;
			const predictor = filter === 0 ? 0
				: filter === 1 ? left
					: filter === 2 ? above
						: filter === 3 ? Math.floor((left + above) / 2)
							: filter === 4 ? paeth(left, above, upperLeft)
								: Number.NaN;
			if (!Number.isFinite(predictor)) throw new Error(`Unsupported PNG row filter ${filter}.`);
			pixels[targetOffset + column] = (source + predictor) & 0xff;
		}
	}

	const rgba = new Uint8Array(width * height * 4);
	for (let index = 0; index < width * height; index += 1) {
		const source = index * channels;
		const target = index * 4;
		if (colorType === 0 || colorType === 4) {
			rgba[target] = pixels[source];
			rgba[target + 1] = pixels[source];
			rgba[target + 2] = pixels[source];
		} else {
			rgba[target] = pixels[source];
			rgba[target + 1] = pixels[source + 1];
			rgba[target + 2] = pixels[source + 2];
		}
		rgba[target + 3] = colorType === 4 ? pixels[source + 1] : colorType === 6 ? pixels[source + 3] : 255;
	}
	return { width, height, rgba };
}

export function encodePng(width, height, rgba) {
	if (rgba.length !== width * height * 4) throw new Error('RGBA pixel data has an unexpected length.');
	const scanlines = Buffer.allocUnsafe((width * 4 + 1) * height);
	for (let row = 0; row < height; row += 1) {
		const target = row * (width * 4 + 1);
		scanlines[target] = 0;
		Buffer.from(rgba.buffer, rgba.byteOffset + row * width * 4, width * 4).copy(scanlines, target + 1);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		PNG_SIGNATURE,
		createChunk('IHDR', header),
		createChunk('IDAT', deflateSync(scanlines)),
		createChunk('IEND', Buffer.alloc(0))
	]);
}

export function comparePng(baselineInput, currentInput, { channelThreshold = 16 } = {}) {
	const baseline = decodePng(baselineInput);
	const current = decodePng(currentInput);
	if (baseline.width !== current.width || baseline.height !== current.height) {
		throw new Error(`PNG dimensions differ: ${baseline.width}x${baseline.height} vs ${current.width}x${current.height}.`);
	}
	const diffPixels = new Uint8Array(baseline.rgba.length);
	let changedPixels = 0;
	for (let offset = 0; offset < baseline.rgba.length; offset += 4) {
		const changed = [0, 1, 2, 3].some(channel => (
			Math.abs(baseline.rgba[offset + channel] - current.rgba[offset + channel]) > channelThreshold
		));
		if (changed) {
			changedPixels += 1;
			diffPixels.set([255, 0, 128, 255], offset);
		} else {
			const gray = Math.round(
				baseline.rgba[offset] * 0.299
				+ baseline.rgba[offset + 1] * 0.587
				+ baseline.rgba[offset + 2] * 0.114
			);
			diffPixels.set([gray, gray, gray, 96], offset);
		}
	}
	const totalPixels = baseline.width * baseline.height;
	return {
		changedPixels,
		totalPixels,
		ratio: changedPixels / totalPixels,
		diff: encodePng(baseline.width, baseline.height, diffPixels)
	};
}
