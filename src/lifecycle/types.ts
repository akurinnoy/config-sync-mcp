export type WorkspacePhase = 'Starting' | 'Running' | 'Stopping' | 'Stopped' | 'Failing' | 'Failed';

export interface TransitionEvent {
  workspace: string;
  previousPhase: WorkspacePhase;
  newPhase: WorkspacePhase;
  timestamp: string;
}

export type TransitionCallback = (event: TransitionEvent) => void;

export interface WatcherConfig {
  namespace: string;
  onTransition: TransitionCallback;
  debounceWindowMs?: number;
}
