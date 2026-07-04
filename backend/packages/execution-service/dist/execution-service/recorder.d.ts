export interface ActionStep {
    action: string;
    target?: any;
    value?: string;
    timestamp: number;
}
export declare class RecorderService {
    private wss;
    private sessions;
    constructor(port: number);
    startRecording(sessionId: string, url: string): Promise<void>;
    stopRecording(sessionId: string): Promise<ActionStep[]>;
}
export declare const recorderService: RecorderService;
//# sourceMappingURL=recorder.d.ts.map