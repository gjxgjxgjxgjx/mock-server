import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';

// 支持通过环境变量自定义 SSE 流式目录；默认使用项目内 mocks_stream 目录
export const MOCK_STREAM_DIR = process.env.MOCK_STREAM_DIR ?? join(process.cwd(), 'mocks_stream');
// 支持通过环境变量指定流式接口配置文件；默认使用项目根目录 stream-config.json
export const STREAM_CONFIG_FILE = process.env.STREAM_CONFIG ?? join(process.cwd(), 'stream-config.json');
// 流式发送的分片间隔（毫秒）
export const SSE_CHUNK_DELAY_MS = process.env.SSE_CHUNK_DELAY_MS ? Number(process.env.SSE_CHUNK_DELAY_MS) : 100;

// 不再自动写入示例内容，保持模块只读取现有 mock 文件

export function loadStreamConfig() {
    try {
        if (existsSync(STREAM_CONFIG_FILE)) {
            const raw = readFileSync(STREAM_CONFIG_FILE, 'utf-8');
            const cfg = JSON.parse(raw);
            const list = Array.isArray(cfg) ? cfg : Array.isArray(cfg?.endpoints) ? cfg.endpoints : [];
            return list.map((p) => String(p));
        }
    } catch {
        // ignore faulty config
    }
    return [];
}

export function isStreamEndpoint(pathname) {
    const configEndpoints = loadStreamConfig();
    if (configEndpoints.includes(pathname)) return true;
    if (pathname.endsWith('/stream')) return true;
    return false;
}

export function resolveStreamFile(baseDir, segments) {
    const lastSeg = segments.length ? segments[segments.length - 1] : 'index';
    const secondLastSeg = segments.length >= 2 ? segments[segments.length - 2] : null;
    const mockDir = secondLastSeg ? join(baseDir, secondLastSeg) : baseDir;
    const ssePath = join(mockDir, `${lastSeg}.sse`);
    const jsonPath = join(mockDir, `${lastSeg}.json`);
    if (existsSync(ssePath)) return ssePath;
    if (existsSync(jsonPath)) return jsonPath;
    // 默认创建 .sse 文件
    return ssePath;
}

export function loadSseLinesFromJson(filePath) {
    const raw = readFileSync(filePath, 'utf-8');
    const cfg = JSON.parse(raw);
    const retryLine = typeof cfg.retry === 'number' ? `retry: ${cfg.retry}` : null;
    const events = Array.isArray(cfg.events) ? cfg.events : [];
    const lines = [];
    if (retryLine) {
        lines.push(retryLine, '');
    }
    for (const ev of events) {
        if (ev.event) lines.push(`event: ${ev.event}`);
        if (typeof ev.id !== 'undefined') lines.push(`id: ${String(ev.id)}`);
        if (typeof ev.data !== 'undefined') {
            const d = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data);
            lines.push(`data: ${d}`);
        }
        lines.push('');
    }
    return lines;
}

export function sendSseFromFile(filePath, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const ext = extname(filePath).toLowerCase();
    let lines = [];
    if (ext === '.json') {
        lines = loadSseLinesFromJson(filePath);
    } else {
        const text = readFileSync(filePath, 'utf-8');
        lines = text.split(/\r?\n/);
    }
    // 确保至少发送一个注释以建立连接
    res.write(': connected\n\n');
    let i = 0;
    const timer = setInterval(() => {
        if (i >= lines.length) {
            clearInterval(timer);
            res.end();
            return;
        }
        const line = lines[i++];
        res.write(line + '\n');
    }, Math.max(0, SSE_CHUNK_DELAY_MS));
}