export declare class ChatOrchestrator {
    /**
     * Main entry point for a new chat message
     */
    handleMessage(userId: string, sessionId: string, message: string, replyCallback: (msg: string) => void, jobStartedCallback?: (payload: {
        jobId: string;
        siteId: string;
        task: string;
        sessionId: string;
        userId: string;
    }) => void): Promise<void>;
    /**
     * Called by the Execution engine via Redis pub/sub when a job pauses for OTP/CAPTCHA
     */
    handleJobPauseRequest(userId: string, sessionId: string, jobId: string, stepId: string, type: import('../shared/types/index.js').InputCardKind, contextMessage: string, replyCallback: (msg: string) => void): Promise<void>;
    private resumeJob;
    private getState;
    private saveState;
    private saveJobRuntimeState;
}
export declare const chatOrchestrator: ChatOrchestrator;
//# sourceMappingURL=chat-orchestrator.d.ts.map