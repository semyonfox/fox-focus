import { createContext, createRef, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AccessibilityInfo, type NativeScrollEvent, type NativeSyntheticEvent, type View } from "react-native";

type DockTab = "index" | "tasks" | "inbox";

type DockState = {
  expanded: boolean;
  reduceMotion: boolean;
  screenReader: boolean;
  expand: () => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  blurTargets: Record<DockTab, RefObject<View | null>>;
};

const DockContext = createContext<DockState | null>(null);

export function DockProvider({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [screenReader, setScreenReader] = useState(false);
  const previousOffset = useRef(0);
  const travel = useRef(0);
  const blurTargets = useRef({
    index: createRef<View>(),
    tasks: createRef<View>(),
    inbox: createRef<View>(),
  }).current;

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => setReduceMotion(true));
    void AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader).catch(() => setScreenReader(true));
    const screenReaderSubscription = AccessibilityInfo.addEventListener("screenReaderChanged", setScreenReader);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { subscription.remove(); screenReaderSubscription.remove(); };
  }, []);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = Math.max(0, event.nativeEvent.contentOffset.y);
    if (offset <= 40 || offset < previousOffset.current) {
      setExpanded(true);
      travel.current = 0;
    } else {
      travel.current += offset - previousOffset.current;
      if (travel.current >= 20) {
        setExpanded(false);
        travel.current = 0;
      }
    }
    previousOffset.current = offset;
  };

  const expand = useCallback(() => {
    travel.current = 0;
    previousOffset.current = 0;
    setExpanded(true);
  }, []);

  return <DockContext value={{ expanded, reduceMotion, screenReader, expand, onScroll, blurTargets }}>{children}</DockContext>;
}

export function useDock(): DockState {
  const dock = useContext(DockContext);
  if (!dock) throw new Error("useDock needs a DockProvider");
  return dock;
}

export function useDockScroll(): DockState["onScroll"] | undefined {
  return useContext(DockContext)?.onScroll;
}
