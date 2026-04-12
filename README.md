# @tokenring-ai/acp

## Overview

The `@tokenring-ai/acp` package provides Agent Client Protocol (ACP) integration for TokenRing agents. It implements the Agent Client Protocol specification, enabling TokenRing agents to communicate with ACP-compatible clients through a stdio-based transport mechanism.

This package serves as a bridge between TokenRing's agent ecosystem and the broader Agent Client Protocol ecosystem, allowing external ACP clients to create sessions, execute commands, manage files, and interact with AI agents in a standardized way.

## Key Features

- **ACP Protocol Implementation**: Full implementation of the Agent Client Protocol specification
- **Session Management**: Create, list, and manage multiple agent sessions with working directory support
- **File System Integration**: Patched FileSystemService for ACP client-based file operations (read, write, append)
- **Terminal Integration**: Patched TerminalService for command execution and interactive terminal sessions
- **Event Streaming**: Real-time forwarding of agent events (chat, reasoning, warnings, errors, artifacts)
- **Permission Handling**: Integration with ACP client for tool approval requests
- **State Management**: Seamless integration with TokenRing agent state persistence
- **Working Directory Support**: Session-specific working directories with path validation and sandboxing

## Installation

```bash
bun add @tokenring-ai/acp
```

## Dependencies

- `@agentclientprotocol/sdk`: ^0.17.0 - Agent Client Protocol SDK
- `@tokenring-ai/agent`: 0.2.0 - Agent orchestration
- `@tokenring-ai/app`: 0.2.0 - Base application framework
- `@tokenring-ai/filesystem`: 0.2.0 - File system service
- `@tokenring-ai/terminal`: 0.2.0 - Terminal service
- `zod`: ^4.3.6 - Schema validation

## Core Components

### ACPService

The main service implementing the Agent Client Protocol for TokenRing.

**Location**: `ACPService.ts`

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

### TokenRingACPAgent

Internal agent implementation that delegates to ACPService.

**Location**: `ACPService.ts` (inner class)

Implements all ACP agent methods:

- `initialize`: Delegates to service
- `authenticate`: No authentication required
- `newSession`: Delegates to service
- `listSessions`: Delegates to service
- `prompt`: Delegates to service
- `cancel`: Delegates to service

### Configuration Schema

**Location**: `schema.ts`

```typescript
export const ACPConfigSchema = z.object({
  transport: z.literal('stdio').default('stdio'),
  defaultAgentType: z.string().optional(),
});

export type ACPConfig = z.output<typeof ACPConfigSchema>;
```

**Configuration Options**:

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `transport` | `"stdio"` | No | `"stdio"` | Transport mechanism (currently only stdio supported) |
| `defaultAgentType` | `string` | No | `undefined` | Default agent type to use for sessions |

## Usage Examples

### Plugin Registration

Register the ACP service in your TokenRing application:

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

### Programmatic Service Registration

```typescript
import TokenRingApp from '@tokenring-ai/app';
import ACPService, { ACPConfigSchema } from '@tokenring-ai/acp';

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

When the ACP client supports file operations, the FileSystemService is patched to route file operations through the ACP connection:

```typescript
// FileSystemService automatically routes through ACP if client supports it
const fileSystemService = app.getService(FileSystemService);

// Read file (routed through ACP if client supports readTextFile)
const content = await fileSystemService.readTextFile('./src/index.ts', agent);

// Write file (routed through ACP if client supports writeTextFile)
await fileSystemService.writeFile('./src/output.txt', 'Hello World', agent);

// Append file (routed through ACP if client supports both read and write)
await fileSystemService.appendFile('./src/output.txt', '\nMore content', agent);
```

### Terminal Operations (ACP Client Integration)

When the ACP client supports terminal operations, the TerminalService is patched to route terminal operations through the ACP connection:

```typescript
const terminalService = app.getService(TerminalService);

// Execute command (routed through ACP)
const result = await terminalService.executeCommand('ls', ['-la'], {
  timeoutSeconds: 30,
  workingDirectory: '/path/to/project'
}, agent);

// Start interactive session
const sessionId = await terminalService.startInteractiveSession(agent, 'bash');

// Send input to session
await terminalService.sendInputToSession(sessionId, 'ls -la', agent);

// Retrieve output
const output = await terminalService.retrieveSessionOutput(sessionId, agent);

// Terminate session
await terminalService.terminateSession(sessionId, agent);
```

## Configuration

### ACP Configuration

Configure the ACP service through the plugin or programmatic registration:

```typescript
import { ACPConfigSchema } from '@tokenring-ai/acp';

const config = ACPConfigSchema.parse({
  transport: 'stdio',
  defaultAgentType: 'coder'
});
```

### Working Directory

All sessions require an absolute path working directory. Relative paths are rejected:

```typescript
// Valid - absolute path
await acpConnection.newSession({ cwd: '/home/user/project' });

// Invalid - relative path (throws error)
await acpConnection.newSession({ cwd: './project' }); // Error: ACP session cwd must be an absolute path
```

### Path Sandboxing

File operations are sandboxed to the session's working directory:

```typescript
// Within session with cwd '/home/user/project'
await fileSystemService.readTextFile('./src/index.ts', agent); // Valid - resolves to /home/user/project/src/index.ts
await fileSystemService.readTextFile('../config.json', agent); // Invalid - outside root directory
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

The ACP service patches the FileSystemService to route operations through the ACP client when capabilities are available:

```typescript
// FileSystemService patching occurs automatically on service start
// File operations are routed through ACP if client supports the capability
// Falls back to local filesystem if client doesn't support the capability
```

### With TerminalService

The ACP service patches the TerminalService to route terminal operations through the ACP client:

```typescript
// TerminalService patching occurs automatically on service start
// Terminal operations are routed through ACP if client supports terminal capability
// Falls back to local terminal if client doesn't support the capability
```

### With AgentEventState

The ACP service integrates with agent event state for streaming responses:

```typescript
// Event types forwarded to ACP client
- 'output.chat': Chat messages
- 'output.reasoning': Reasoning/thought content
- 'output.info': Informational messages
- 'output.warning': Warnings
- 'output.error': Errors
- 'output.artifact': File attachments/artifacts
```

## RPC Endpoints

The ACP service implements the following ACP protocol endpoints through the AgentSideConnection:

| Endpoint | Request | Response | Description |
|----------|---------|----------|-------------|
| `initialize` | `InitializeRequest` | `InitializeResponse` | Initialize ACP connection with client capabilities |
| `authenticate` | `AuthenticateRequest` | `AuthenticateResponse` | Authentication (currently no-op) |
| `newSession` | `NewSessionRequest` | `NewSessionResponse` | Create new agent session |
| `listSessions` | `ListSessionsRequest` | `ListSessionsResponse` | List active sessions |
| `prompt` | `PromptRequest` | `PromptResponse` | Send prompt and stream response |
| `cancel` | `CancelNotification` | `void` | Cancel active prompt |
| `sessionUpdate` | `SessionUpdate` | `void` | Send session updates (file/terminal operations) |
| `readTextFile` | `ReadTextFileRequest` | `ReadTextFileResponse` | Read file through ACP client |
| `writeTextFile` | `WriteTextFileRequest` | `WriteTextFileResponse` | Write file through ACP client |
| `createTerminal` | `CreateTerminalRequest` | `CreateTerminalResponse` | Create terminal through ACP client |

## Chat Commands

The ACP package does not define chat commands directly. Commands are handled through the ACP protocol's prompt mechanism.

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
};
```

### Agent State Integration

ACP sessions integrate with agent state slices:

- `FileSystemState`: Working directory and file system configuration
- `TerminalState`: Terminal session management and output tracking
- `AgentEventState`: Event cursor and streaming state

### State Persistence

Session state is persisted through the agent's state management system:

```typescript
// File system state
const fsState = agent.getState(FileSystemState);
const workingDirectory = fsState.workingDirectory;

// Terminal state
const terminalState = agent.getState(TerminalState);
const session = terminalState.getSession(terminalId);
```

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

- `@tokenring-ai/agent`: Agent orchestration and management
- `@tokenring-ai/app`: Base application framework
- `@tokenring-ai/filesystem`: File system service
- `@tokenring-ai/terminal`: Terminal service
- `@agentclientprotocol/sdk`: Agent Client Protocol SDK

## Best Practices

1. **Working Directory**: Always use absolute paths for session working directories
2. **Path Validation**: File operations are automatically sandboxed to the working directory
3. **Session Lifecycle**: Properly manage session creation and cleanup to avoid resource leaks
4. **Capability Detection**: Check client capabilities before relying on file/terminal operations
5. **Error Handling**: Implement proper error handling for ACP protocol operations
6. **Timeout Management**: Use appropriate timeouts for long-running terminal operations
7. **State Management**: Leverage agent state slices for persistent session data

## Development Notes

### Service Patching

The ACP service patches FileSystemService and TerminalService at startup to intercept operations and route them through the ACP client when capabilities are available. This patching occurs only once per service instance.

### Event Forwarding

Agent events are forwarded to the ACP client in real-time:

- Chat messages → `agent_message_chunk`
- Reasoning/thoughts → `agent_thought_chunk`
- Artifacts → `resource` content blocks

### Permission Handling

Tool approvals are handled through the ACP client's permission system:

- `askForApproval`: Prompts client for tool approval
- `askForText`: Not supported in ACP mode
- `askQuestion`: Not supported in ACP mode

### Session Cleanup

Sessions are cleaned up when:

- The ACP connection is closed
- The service is stopped
- The application is shut down

All terminal handles are released and agents are deleted during cleanup.
