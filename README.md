# @tokenring-ai/acp

## Overview

The `@tokenring-ai/acp` package provides Agent Client Protocol (ACP) integration for TokenRing agents. It implements the
Agent Client Protocol specification, enabling TokenRing agents to communicate with ACP-compatible clients through a
stdio-based transport mechanism.

This package serves as a bridge between TokenRing's agent ecosystem and the broader Agent Client Protocol ecosystem,
allowing external ACP clients to create sessions, execute commands, manage files, and interact with AI agents in a
standardized way.

## Key Features

- **ACP Protocol Implementation**: Full implementation of the Agent Client Protocol specification
- **Session Management**: Create, list, and manage multiple agent sessions with working directory support
- **File System Integration**: ACP-compatible file system provider for file operations (read, write, append)
- **Terminal Integration**: ACP-compatible terminal provider for command execution
- **Event Streaming**: Real-time forwarding of agent events (chat, reasoning, warnings, errors, artifacts)
- **Permission Handling**: Integration with ACP client for tool approval requests
- **State Management**: Seamless integration with TokenRing agent state persistence
- **Working Directory Support**: Session-specific working directories with path validation

## Installation

```bash
bun add @tokenring-ai/acp
```

## Dependencies

- `@agentclientprotocol/sdk`: ^0.18.0 - Agent Client Protocol SDK
- `@tokenring-ai/agent`: workspace:* - Agent orchestration
- `@tokenring-ai/app`: workspace:* - Base application framework
- `@tokenring-ai/filesystem`: workspace:* - File system service
- `@tokenring-ai/terminal`: workspace:* - Terminal service
- `zod`: ^4.3.6 - Schema validation

## Chat Commands

This package does not define chat commands. Interactions are handled through the ACP protocol's prompt mechanism.

## Tools

This package does not define tools. Tool execution is handled through the ACP protocol.

## Configuration

### Configuration Schema

**Location**: `schema.ts`

```typescript
export const ACPConfigSchema = z.object({
  transport: z.literal('stdio').default('stdio'),
  defaultAgentType: z.string().exactOptional(),
});

export type ACPConfig = z.output<typeof ACPConfigSchema>;
```

### Configuration Options

| Property           | Type      | Required | Default     | Description                                          |
|--------------------|-----------|----------|-------------|------------------------------------------------------|
| `transport`        | `"stdio"` | No       | `"stdio"`   | Transport mechanism (currently only stdio supported) |
| `defaultAgentType` | `string`  | No       | `undefined` | Default agent type to use for sessions               |

### Plugin Configuration

Configure the ACP service through the plugin:

```typescript
import TokenRingApp from '@tokenring-ai/app';
import acpPlugin from '@tokenring-ai/acp/plugin';

const app = new TokenRingApp();

await app.install(acpPlugin, {
  acp: {
    defaultAgentType: 'coder'
  }
});

await app.start();
```

### Programmatic Configuration

```typescript
import TokenRingApp from '@tokenring-ai/app';
import {ACPService, ACPConfigSchema} from '@tokenring-ai/acp';

const app = new TokenRingApp();
const config = ACPConfigSchema.parse({
  defaultAgentType: 'coder'
});

app.addServices(new ACPService(app, config));
await app.start();

// ACP connection runs via stdio
const signal = AbortSignal.timeout(30000);
await app.run(signal);
```

## Exports

The package exports the following:

```typescript
// Main service
export { default as ACPService } from "./ACPService.ts";

// Configuration schema
export { ACPConfigSchema } from "./schema.ts";

// Plugin for easy integration
// import acpPlugin from '@tokenring-ai/acp/plugin';
```

## Core Components

### ACPService

The main service implementing the Agent Client Protocol for TokenRing.

**Location**: `ACPService.ts`

**Implements**: `TokenRingService`

**Key Methods**:

#### `initialize(params: InitializeRequest): InitializeResponse`

Initializes the ACP connection and returns protocol capabilities.

**Parameters**:

- `params`: `InitializeRequest` - ACP initialization request containing client capabilities

**Returns**: `InitializeResponse` - Protocol version and agent capabilities

#### `createSession(params: NewSessionRequest): Promise<NewSessionResponse>`

Creates a new ACP session with a TokenRing agent.

**Parameters**:

- `params`: `NewSessionRequest` - Session creation request with working directory

**Returns**: `NewSessionResponse` - Created session ID

**Example**:

```typescript
const response = await acpService.createSession({
  cwd: '/path/to/working/directory'
});
// response.sessionId => 'uuid-string'
```

#### `listSessions(params: ListSessionsRequest): ListSessionsResponse`

Lists all active sessions, optionally filtered by working directory.

**Parameters**:

- `params`: `ListSessionsRequest` - Optional working directory filter

**Returns**: `ListSessionsResponse` - Array of session info

#### `prompt(connection: AgentSideConnection, params: PromptRequest): Promise<PromptResponse>`

Handles ACP prompt requests, streaming agent responses back to the client.

**Parameters**:

- `connection`: `AgentSideConnection` - ACP connection instance
- `params`: `PromptRequest` - Prompt request with message and attachments

**Returns**: `PromptResponse` - Response with stop reason and message ID

#### `cancel(params: CancelNotification): void`

Cancels an active prompt in a session.

**Parameters**:

- `params`: `CancelNotification` - Cancellation notification with session ID

#### `start(): void`

Starts the ACP service and initializes the stdio transport connection.

#### `run(signal: AbortSignal): Promise<void>`

Runs the ACP service until the connection is closed or signal is aborted.

#### `stop(): void`

Stops the ACP service and cleans up all sessions.

### ACPFileSystemProvider

File system provider that routes file operations through the ACP connection.

**Location**: `ACPFileSystemProvider.ts`

**Supported Operations**:

- `readFile`: Reads file content through ACP client
- `writeFile`: Writes file content through ACP client
- `appendFile`: Appends content to file through ACP client
- `exists`: Checks if file exists through ACP client
- `stat`: Gets file statistics through ACP client

**Unsupported Operations**:

- `deleteFile`: Not supported in ACP mode
- `rename`: Not supported in ACP mode
- `createDirectory`: Not supported in ACP mode
- `copy`: Not supported in ACP mode
- `getDirectoryTree`: Not supported in ACP mode

### ACPTerminalProvider

Terminal provider that routes terminal operations through the ACP connection.

**Location**: `ACPTerminalProvider.ts`

**Supported Operations**:

- `executeCommand`: Executes commands through ACP client terminal
- `runScript`: Runs shell scripts through ACP client terminal

**Configuration**:

- `isInteractive`: `false` (non-interactive terminal provider)
- `supportedIsolationLevels`: `["none"]`

## Usage Examples

### Session Management

```typescript
// Create a session
const sessionResponse = await acpConnection.newSession({
  cwd: '/path/to/project'
});
const sessionId = sessionResponse.sessionId;

// List sessions
const listResponse = await acpConnection.listSessions({
  cwd: '/path/to/project' // optional filter
});

// Send a prompt
const promptResponse = await acpConnection.prompt({
  sessionId,
  message: [
    {
      type: 'text',
      text: 'Analyze this codebase'
    }
  ]
});
```

### File Operations (ACP Client Integration)

When the ACP client supports file operations, the ACPFileSystemProvider routes file operations through the ACP
connection:

```typescript
// File operations are routed through ACP if client supports the capability
const fileSystemService = app.getService(FileSystemService);

// Register the ACP file system provider for a session
fileSystemService.registerFileSystemProvider(
  'acp-fs-session123',
  new ACPFileSystemProvider(connection, sessionId, clientCapabilities)
);

// Read file (routed through ACP)
const content = await fileSystemService.readTextFile('./src/index.ts', agent);

// Write file (routed through ACP)
await fileSystemService.writeFile('./src/output.txt', 'Hello World', agent);

// Append file (routed through ACP)
await fileSystemService.appendFile('./src/output.txt', '\nMore content', agent);
```

### Terminal Operations (ACP Client Integration)

When the ACP client supports terminal operations, the ACPTerminalProvider routes terminal operations through the ACP
connection:

```typescript
const terminalService = app.getService(TerminalService);

// Register the ACP terminal provider for a session
terminalService.registerTerminalProvider(
  'acp-terminal-session123',
  new ACPTerminalProvider(connection, sessionId)
);

// Execute command (routed through ACP)
const result = await terminalService.executeCommand('ls', ['-la'], {
  timeoutSeconds: 30,
  workingDirectory: '/path/to/project'
}, agent);
```

## Integration

### With AgentSystem

The ACP service integrates with the TokenRing agent system through the `AgentManager`:

```typescript
const agentManager = app.getService(AgentManager);

// ACP service uses AgentManager to spawn agents for each session
const session = await acpService.createSession({ cwd: '/path/to/project' });

// Each session gets its own agent instance with decorated ACP handlers
const agent = session.agent;
```

### With FileSystemService

The ACP service registers an `ACPFileSystemProvider` with the FileSystemService when the ACP client supports file
capabilities:

```typescript
// ACPFileSystemProvider is registered automatically when client capabilities are detected
// File operations are routed through ACP if client supports readTextFile/writeTextFile
// Falls back to other providers if ACP client doesn't support the capability
```

### With TerminalService

The ACP service registers an `ACPTerminalProvider` with the TerminalService when the ACP client supports terminal
capabilities:

```typescript
// ACPTerminalProvider is registered automatically when client capabilities are detected
// Terminal operations are routed through ACP if client supports terminal capability
```

### With AgentEventState

The ACP service integrates with agent event state for streaming responses:

```typescript
// Event types forwarded to ACP client
// - 'output.chat': Chat messages
// - 'output.reasoning': Reasoning/thought content
// - 'output.info': Informational messages
// - 'output.warning': Warnings
// - 'output.error': Errors
// - 'output.artifact': File attachments/artifacts
```

## ACP Protocol Endpoints

The ACP service implements the following ACP protocol methods through the AgentSideConnection:

| Endpoint       | Request               | Response               | Description                                        |
|----------------|-----------------------|------------------------|----------------------------------------------------|
| `initialize`   | `InitializeRequest`   | `InitializeResponse`   | Initialize ACP connection with client capabilities |
| `authenticate` | `AuthenticateRequest` | `AuthenticateResponse` | Authentication (currently no-op)                   |
| `newSession`   | `NewSessionRequest`   | `NewSessionResponse`   | Create new agent session                           |
| `listSessions` | `ListSessionsRequest` | `ListSessionsResponse` | List active sessions                               |
| `prompt`       | `PromptRequest`       | `PromptResponse`       | Send prompt and stream response                    |
| `cancel`       | `CancelNotification`  | `void`                 | Cancel active prompt                               |

## State Management

### Session State

Each ACP session maintains:

```typescript
type ACPSession = {
  sessionId: string;           // Unique session identifier
  cwd: string;                 // Working directory
  agent: TokenRingAgent;       // Agent instance for this session
  activePrompt: ACPPromptState | null; // Current active prompt state
  updatedAt: string;           // Last update timestamp
  fileSystemProviderName?: string;     // Registered file system provider name
  terminalProvider?: ACPTerminalProvider; // Terminal provider instance
  terminalProviderName?: string;         // Registered terminal provider name
};
```

### Agent State Integration

ACP sessions integrate with agent state slices:

- `FileSystemState`: Working directory and file system configuration
- `TerminalState`: Terminal session management and output tracking
- `AgentEventState`: Event cursor and streaming state

## Testing and Development

### Running Tests

```bash
cd pkg/acp
bun test
```

### Watch Mode

```bash
bun test:watch
```

### Coverage

```bash
bun test:coverage
```

### Build

```bash
bun build
```

## License

MIT License - see LICENSE file for details.

## Related Components

### Core Dependencies

- `@tokenring-ai/agent`: Agent orchestration and management
- `@tokenring-ai/app`: Base application framework
- `@tokenring-ai/filesystem`: File system service
- `@tokenring-ai/terminal`: Terminal service

### External Dependencies

- `@agentclientprotocol/sdk`: Agent Client Protocol SDK
- `zod`: Schema validation

## Best Practices

1. **Working Directory**: Always use absolute paths for session working directories
2. **Path Validation**: File operations are automatically sandboxed to the working directory
3. **Session Lifecycle**: Properly manage session creation and cleanup to avoid resource leaks
4. **Capability Detection**: Check client capabilities before relying on file/terminal operations
5. **Error Handling**: Implement proper error handling for ACP protocol operations
6. **Timeout Management**: Use appropriate timeouts for long-running terminal operations

## Development Notes

### Session Providers

The ACP service registers file system and terminal providers with the respective TokenRing services when the ACP client
advertises the corresponding capabilities:

- `ACPFileSystemProvider`: Registered with `FileSystemService` when client supports `fs.readTextFile` or
  `fs.writeTextFile`
- `ACPTerminalProvider`: Registered with `TerminalService` when client supports `terminal`

### Event Forwarding

Agent events are forwarded to the ACP client in real-time:

- Chat messages → `agent_message_chunk`
- Reasoning/thoughts → `agent_thought_chunk`
- Artifacts → `resource` content blocks

### Permission Handling

Tool approvals are handled through the ACP client's permission system:

- `askForApproval`: Prompts client for tool approval
- `askForText`: Not supported in ACP mode (throws error)
- `askQuestion`: Not supported in ACP mode (throws error)

### Session Cleanup

Sessions are cleaned up when:

- The ACP connection is closed
- The service is stopped
- The application is shut down

All terminal handles are released and agents are deleted during cleanup.
