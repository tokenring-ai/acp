import type {AgentSideConnection, ClientCapabilities,} from "@agentclientprotocol/sdk";
import type {DirectoryTreeOptions, FileSystemProvider, StatLike} from "@tokenring-ai/filesystem/FileSystemProvider";

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

  async writeFile(
    absolutePath: string,
    content: string | Buffer,
  ): Promise<boolean> {
    const textContent = toTextContent(content);
    await this.connection.writeTextFile({
      sessionId: this.sessionId,
      path: absolutePath,
      content: textContent,
    });
    return true;
  }

  async appendFile(
    absolutePath: string,
    content: string | Buffer,
  ): Promise<boolean> {
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
      await this.connection.readTextFile({
        sessionId: this.sessionId,
        path: absolutePath,
      });
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
      await this.connection.readTextFile({
        sessionId: this.sessionId,
        path: absolutePath,
      });
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

  deleteFile(_absolutePath: string): Promise<boolean> {
    throw new Error("ACP FileSystemProvider does not support deleteFile");
  }

  rename(_oldPath: string, _newPath: string): Promise<boolean> {
    throw new Error("ACP FileSystemProvider does not support rename");
  }

  createDirectory(
    _absolutePath: string,
    _options?: { recursive?: boolean },
  ): Promise<boolean> {
    throw new Error("ACP FileSystemProvider does not support createDirectory");
  }

  copy(
    _src: string,
    _dest: string,
    _options?: { overwrite?: boolean },
  ): Promise<boolean> {
    throw new Error("ACP FileSystemProvider does not support copy");
  }

  getDirectoryTree(
    _dir: string,
    _options?: DirectoryTreeOptions,
  ): Generator<string> {
    throw new Error("ACP FileSystemProvider does not support getDirectoryTree");
  }
}

function toTextContent(content: string | Buffer): string {
  return typeof content === "string" ? content : content.toString("utf-8");
}
