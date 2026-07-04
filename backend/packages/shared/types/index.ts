// ============================================================
// SHARED TYPES — used across all services
// ============================================================

export type JobStatus = 'pending' | 'active' | 'completed' | 'failed' | 'retrying';
export type JobPriority = 'critical' | 'high' | 'normal' | 'low';
export type JobType = 'crawl' | 'execute' | 'remap' | 'ai-plan' | 'health-check';

// ─── Job Definitions ────────────────────────────────────────

export interface BaseJob {
  id: string;
  type: JobType;
  priority: JobPriority;
  createdAt: Date;
  userId: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface CrawlJob extends BaseJob {
  type: 'crawl';
  payload: {
    url: string;
    maxDepth: number;
    maxPages: number;
    strategy: 'bfs' | 'dfs' | 'hybrid';
    followExternalLinks: boolean;
    respectRobots: boolean;
  };
}

export interface ExecuteJob extends BaseJob {
  type: 'execute';
  payload: {
    siteId: string;
    task: string;           // natural language
    actionPlan?: ActionStep[];  // pre-computed or AI-generated
    sessionId: string;
    useCache: boolean;
    dryRun?: boolean;
    lightweight?: boolean;
  };
}

export interface RemapJob extends BaseJob {
  type: 'remap';
  payload: {
    siteId: string;
    affectedUrls?: string[];  // empty = full remap
    reason: 'scheduled' | 'change-detected' | 'selector-failure';
  };
}

export interface AIPlanJob extends BaseJob {
  type: 'ai-plan';
  payload: {
    siteId: string;
    task: string;
    domSnapshot: DOMSnapshot;
  };
}

// ─── Site & DOM Types ────────────────────────────────────────

export interface SiteMap {
  id: string;
  domain: string;
  createdAt: Date;
  updatedAt: Date;
  pageCount: number;
  graph: SiteGraph;
}

export interface SiteGraph {
  nodes: Map<string, PageNode>;
  edges: PageEdge[];
}

export interface PageNode {
  id: string;
  url: string;
  title: string;
  loadTime: number;
  reliabilityScore: number;       // 0–1, decreases on failures
  lastVerified: Date;
  elements: ExtractedElement[];
  snapshot?: DOMSnapshot;
}

export interface PageEdge {
  from: string;   // page node id
  to: string;     // page node id
  linkText: string;
  selector: string;
  navigationType: 'click' | 'form-submit' | 'direct';
}

export interface ExtractedElement {
  id: string;
  type: 'button' | 'input' | 'select' | 'link' | 'form' | 'text' | 'image' | 'other';
  label: string;
  selectors: SelectorCandidate[];  // ranked by confidence
  attributes: Record<string, string>;
  boundingBox?: BoundingBox;
  visible: boolean;
  interactable: boolean;
}

export interface SelectorCandidate {
  value: string;
  type: 'css' | 'xpath' | 'text' | 'aria' | 'ai-generated';
  confidence: number;  // 0–1
  lastValidated: Date;
  failureCount: number;
}

export interface DOMSnapshot {
  url: string;
  timestamp: Date;
  html: string;
  simplified: SimplifiedDOM[];
}

export interface SimplifiedDOM {
  tag: string;
  text?: string;
  role?: string;
  attributes: Record<string, string>;
  children: SimplifiedDOM[];
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── Action Types ────────────────────────────────────────────

export interface ActionStep {
  id: string;
  order?: number;
  action: ActionType;
  target?: {
    value: string;
    type?: 'css' | 'text' | 'role' | 'testid' | 'xpath' | 'url';
    confidence?: number;
    fallbackSelectors?: string[];
    roleName?: string;
    roleOptions?: Record<string, unknown>;
  };
  value?: string;
  description?: string;
  waitFor?: string;
  timeout?: number;
  retries?: number;
  humanDelay?: boolean;
  humanType?: boolean;
  expectedInput?: 'otp' | 'upi_id' | 'captcha' | 'clickCaptcha' | 'confirmation' | 'text' | 'email' | 'mobile' | 'password' | 'file';
  contextMessage?: string;
  condition?: {
    type: 'exists' | 'contains_text' | 'url_contains' | 'status';
    target?: string;
    value?: string;
  };
  trueSteps?: ActionStep[];
  falseSteps?: ActionStep[];
  metadata?: Record<string, any>;
}

export type ActionType =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'upload'
  | 'download'
  | 'waitForSelector'
  | 'waitForNavigation'
  | 'waitForTimeout'
  | 'scroll'
  | 'mouseMove'
  | 'humanType'
  | 'pauseForUserInput'
  | 'extractData'
  | 'runSubWorkflow'
  | 'conditional'
  | 'customJS'
  | 'refresh'
  | 'wait'
  | 'screenshot'
  | 'extract'
  | 'payment'
  | 'retryLoop'
  | 'clickCaptcha'
  // New universal actions
  | 'pressKey'
  | 'doubleClick'
  | 'hover'
  | 'rightClick'
  | 'clearField'
  | 'switchTab'
  | 'closeTab'
  | 'acceptDialog'
  | 'dismissDialog'
  | 'assertText'
  | 'assertURL'
  | 'iframe'
  | 'loop'
  | 'dragDrop'
  | 'goBack'
  | 'goForward'
  | 'credentialFill'
  | 'paymentGateway';

// ─── Execution Results ───────────────────────────────────────

export interface ExecutionResult {
  jobId: string;
  success: boolean;
  steps: StepResult[];
  duration: number;
  screenshots: string[];
  extractedData?: Record<string, unknown>;
  error?: string;
  sessionId: string;
}

export interface StepResult {
  stepId: string;
  success: boolean;
  duration: number;
  selectorUsed?: string;
  selectorType?: string;
  error?: string;
  retryCount: number;
}

// ─── Session Types ───────────────────────────────────────────

export interface Session {
  id: string;
  userId: string;
  siteId: string;
  createdAt: Date;
  lastUsed: Date;
  cookies: SerializedCookie[];
  localStorage: Record<string, string>;
  proxy?: ProxyConfig;
  browserContextId?: string;
  isActive: boolean;
}

export interface SerializedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

// ─── Proxy Types ─────────────────────────────────────────────

export interface ProxyConfig {
  id: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol: 'http' | 'https' | 'socks5';
  healthScore: number;   // 0–1
  latencyMs: number;
  failureRate: number;   // 0–1
  lastChecked: Date;
  tags: string[];        // e.g. ['residential', 'US']
}

// ─── AI Types ────────────────────────────────────────────────

export interface AIDecision {
  confidence: number;
  reasoning: string;
  actionPlan: ActionStep[];
  fallbackPlan?: ActionStep[];
  estimatedDuration: number;
  warnings: string[];
  source?: 'structured-workflow' | 'cached-flow' | 'ai-generated';
  matchedWorkflowId?: string;
  matchedWorkflowName?: string;
}

export interface CachedFlow {
  id: string;
  siteId: string;
  taskHash: string;      // hash of normalized task
  task: string;
  actionPlan: ActionStep[];
  successCount: number;
  failureCount: number;
  lastUsed: Date;
  avgDuration: number;
}

// ─── Metrics Types ───────────────────────────────────────────

export interface JobMetrics {
  jobId: string;
  type: JobType;
  duration: number;
  success: boolean;
  aiCallCount: number;
  selectorFallbackCount: number;
  retryCount: number;
  proxyId?: string;
}

// ─── Chat Orchestrator Types ─────────────────────────────────

export interface ConversationState {
  userId: string;
  sessionId: string;
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  activeJobId?: string;
  awaitingInput?: {
    jobId: string;
    stepId: string;
    type: 'otp' | 'upi_id' | 'captcha' | 'clickCaptcha' | 'confirmation' | 'text' | 'email' | 'mobile' | 'password' | 'file';
    contextMessage: string;
  };
  memoryContext: Record<string, any>;
  lastUpdated: Date;
}

export interface JobRuntimeState {
  jobId: string;
  userId: string;
  sessionId: string;
  siteId: string;
  task: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed';
  activeStepId?: string;
  lastInputType?: 'otp' | 'upi_id' | 'captcha' | 'clickCaptcha' | 'confirmation' | 'text' | 'email' | 'mobile' | 'password' | 'file';
  error?: string;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SiteWorkflow {
  id: string;
  workflowKey?: string;
  siteId: string;
  category?: string;
  name: string;
  trigger: string;
  triggerPhrases?: string[];
  portalType?: 'government' | 'jobs' | 'education' | 'banking' | 'general' | 'aadhaar';
  siteSection?: string;
  entryUrl?: string;
  pageUrl?: string;
  pageUrlPattern?: string;
  pageUrlPatterns?: string[];
  requiredInputs?: string[];
  requiredFiles?: Array<'resume' | 'signature' | 'photo' | 'document' | 'receipt' | 'other'>;
  instructions: string;
  defaultProfileName?: string;
  starterActionPlan?: ActionStep[];
  errorRecoveryPlan?: ActionStep[];
  version?: number;
  isActive?: boolean;
  completionArtifact?: string;
  metadata?: Record<string, unknown> & { lightweight?: boolean };
  createdAt: Date;
  updatedAt: Date;
}

export interface UserFile {
  id: string;
  userId: string;
  profileName?: string;
  category: 'resume' | 'signature' | 'photo' | 'document' | 'receipt' | 'other';
  originalName: string;
  storedName: string;
  mimeType: string;
  fileSizeBytes: number;
  storagePath: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
