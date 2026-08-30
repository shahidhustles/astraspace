import { JellyBlobMascot } from "feral-blob";

type AstraBlobProps = {
  isComposing: boolean;
  isWorking?: boolean;
  className?: string;
};

export function AstraBlob({
  isComposing,
  isWorking = false,
  className = "size-28",
}: AstraBlobProps) {
  const isActive = isComposing || isWorking;
  return (
    <div aria-hidden className="astra-blob pointer-events-none">
      <JellyBlobMascot
        className={className}
        gaze={
          isComposing
            ? { intensity: 0.7, x: 12, y: 8 }
            : isWorking
              ? { intensity: 0.45, x: 6, y: -4 }
              : { x: 0, y: 0 }
        }
        mood={isComposing ? "happy" : isWorking ? "hmm" : "neutral"}
        nod={isActive}
      />
    </div>
  );
}
