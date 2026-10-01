import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** 사진 저장소 추상화. 데모는 로컬 디스크, 호스팅 확정 후 S3 등으로 교체한다. */
export interface PhotoStorage {
  /** key 로 저장하고 클라이언트가 접근할 URL 을 돌려준다. 저장은 원자적이어야 한다(반쯤 쓰인 파일이 보이면 안 된다). */
  save(key: string, data: Buffer): Promise<string>;
  /** 파일 삭제. 이미 없으면(ENOENT) 조용히 성공하고, 그 밖의 오류는 기록하되 던지지 않는다(DB 정리를 막지 않기 위함). */
  delete(key: string): Promise<void>;
  /** 저장된 원본 바이트를 읽는다(AI 전송용 사본 생성 등). */
  read(key: string): Promise<Buffer>;
  /**
   * 저장된 파일(키, 수정 시각). 고아 파일 정리용.
   * prefixes 를 주면 해당 키 접두사(예: 'photos/', 'ai/')만 훑는다. 나열 중 사라진 파일은 건너뛴다.
   */
  list(opts?: { prefixes?: string[] }): Promise<{ key: string; mtimeMs: number }[]>;
}

export const FILES_URL_PREFIX = '/api/v1/files/';

export interface StorageLogger {
  warn(message: string): void;
}

const isNotFound = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

export class LocalDiskStorage implements PhotoStorage {
  private readonly root: string;
  constructor(
    root: string,
    private readonly logger?: StorageLogger,
  ) {
    this.root = resolve(root);
  }

  get rootDir() {
    return this.root;
  }

  private pathFor(key: string) {
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error('잘못된 저장 경로');
    return full;
  }

  /** 임시 파일에 쓴 뒤 rename(같은 디렉터리·같은 파일시스템에서 원자적). 중간에 죽어도 잘린 파일이 최종 키로 보이지 않는다. */
  async save(key: string, data: Buffer) {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, full);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    return FILES_URL_PREFIX + key;
  }

  async list(opts: { prefixes?: string[] } = {}) {
    const out: { key: string; mtimeMs: number }[] = [];
    const walk = async (dir: string, prefix: string) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isDirectory()) {
          await walk(join(dir, e.name), `${prefix}${e.name}/`);
        } else {
          const key = `${prefix}${e.name}`;
          if (opts.prefixes && !opts.prefixes.some((p) => key.startsWith(p))) continue;
          try {
            out.push({ key, mtimeMs: (await stat(join(dir, e.name))).mtimeMs });
          } catch (err) {
            if (!isNotFound(err)) throw err; // 나열 중 삭제된 파일은 건너뛴다
          }
        }
      }
    };
    await walk(this.root, '');
    return out;
  }

  async read(key: string) {
    return readFile(this.pathFor(key));
  }

  async delete(key: string) {
    try {
      await unlink(this.pathFor(key));
    } catch (e) {
      if (isNotFound(e)) return;
      // EPERM/EBUSY/EISDIR 등은 숨기지 않고 기록한다. 던지면 DB 정리 전체가 멈추므로 호출 측에는 성공으로 돌려준다.
      this.logger?.warn(`파일 삭제 실패(${key}): ${(e as NodeJS.ErrnoException).code ?? 'unknown'}`);
    }
  }
}
