import type {AgentSideConnection, ClientCapabilities} from "@agentclientprotocol/sdk";
import type FileSystemProvider from "@tokenring-ai/filesystem/FileSystemProvider";
import type {DirectoryTreeOptions, GlobOptions, GrepOptions, GrepResult, StatLike, WatchOptions} from "@tokenring-ai/filesystem/FileSystemProvider";

export default class ACPFileSystemProvider implements FileSystemProvider {
  readonly name = "ACPFileSystemProvider";
  readonly displayName: string;

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly sessionId: string,
    private readonly capabilities: ClientCapabilities,
  ) {
    this.displayName = `ACP FileSystem (session: ${sessionId})`;
  }

  async readFile(absolutePath: string): Promise<Buffer | null> {
    if (!this.capabilities.fs?.readTextFile) {
      return null;
    }
    try {
      const response = await this.connection.readTextFile({
        sessionId: this.sessionId,
        path: absolutePath,
      });
      return Buffer.from(response.content, "utf-8");
    } catch {
      return null;
    }
  }

  async writeFile(absolutePath: string, content: string | Buffer): Promise<boolean> {
    const textContent = toTextContent(content);
    await this.connection.writeTextFile({
      sessionId: this.sessionId,
      path: absolutePath,
      content: textContent,
    });
    return true;
  }

  async appendFile(absolutePath: string, content: string | Buffer): Promise<boolean> {
    const textContent = toTextContent(content);
    const current = await this.connection.readTextFile({
      sessionId: this.sessionId,
      path: absolutePath,
    });
    await this.connection.writeTextFile({
      sessionId: this.sessionId,
      path: absolutePath,
      content: `${current.content}${textContent}`,
    });
    return true;
  }

  async exists(absolutePath: string): Promise<boolean> {
    if (!this.capabilities.fs?.readTextFile) {
      return false;
    }
    try {
      await this.connection.readTextFile({sessionId: this.sessionId, path: absolutePath});
      return true;
    } catch {
      return false;
    }
  }

  async stat(absolutePath: string): Promise<StatLike> {
    if (!this.capabilities.fs?.readTextFile) {
      return {exists: false, path: absolutePath};
    }
    try {
      await this.connection.readTextFile({sessionId: this.sessionId, path: absolutePath});
      return {
        exists: true,
        path: absolutePath,
        absolutePath,
        isFile: true,
        isDirectory: false,
      };
    } catch {
      return {exists: false, path: absolutePath};
    }
  }

  async deleteFile(_absolutePath: string): Promise<boolean> {
    throw new Error("ACP FileSystemProvider does not support deleteFile");
  }

  async rename(_oldPath: string, _newPath: string): Promise<boolean> {
    throw new Error("ACP FileSystemProvider does not support rename");
  }

  async createDirectory(_absolutePath: string, _options?: {recursive?: boolean}): Promise<boolean> {
    throw new Error("ACP FileSystemProvider does not support createDirectory");
  }

  async copy(_src: string, _dest: string, _options?: {overwrite?: boolean}): Promise<boolean> {
    throw new Error("ACP FileSystemProvider does not support copy");
  }

  async* getDirectoryTree(_dir: string, _options?: DirectoryTreeOptions): AsyncGenerator<string> {
    throw new Error("ACP FileSystemProvider does not support getDirectoryTree");
  }

  async watch(_dir: string, _options?: WatchOptions): Promise<never> {
    throw new Error("ACP FileSystemProvider does not support watch");
  }

  async glob(_pattern: string, _options?: GlobOptions): Promise<string[]> {
    throw new Error("ACP FileSystemProvider does not support glob");
  }

  async grep(_searchString: string | string[], _options?: GrepOptions): Promise<GrepResult[]> {
    throw new Error("ACP FileSystemProvider does not support grep");
  }
}

function toTextContent(content: string | Buffer): string {
  return typeof content === "string" ? content : content.toString("utf-8");
}
