import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { BlurTargetView, BlurView } from "expo-blur";
import { Tabs } from "expo-router";
import { Clock3, Inbox, ListTodo } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { needsCount } from "@/lib/derive";
import { useDock } from "@/lib/dock";
import { useStore } from "@/lib/store";
import { colors } from "@/lib/theme";

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];

function DockIcon({ name, color }: { name: string; color: string }) {
  if (name === "tasks") return <ListTodo size={26} color={color} strokeWidth={2} />;
  if (name === "inbox") return <Inbox size={26} color={color} strokeWidth={2} />;
  return <Clock3 size={26} color={color} strokeWidth={2} />;
}

export function DockScene({ tab, children }: { tab: "index" | "tasks" | "inbox"; children: ReactNode }) {
  const { blurTargets } = useDock();
  return <BlurTargetView ref={blurTargets[tab]} style={styles.scene}>{children}</BlurTargetView>;
}

export function Dock({ state, descriptors, navigation }: TabBarProps) {
  const { expanded, expand, reduceMotion, blurTargets } = useDock();
  const { rows } = useStore();
  const needs = needsCount(rows);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const progress = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(expanded ? 1 : 0);
      return;
    }
    Animated.timing(progress, { toValue: expanded ? 1 : 0, duration: 280, useNativeDriver: false }).start();
  }, [expanded, progress, reduceMotion]);

  useEffect(() => { expand(); }, [expand, state.index]);

  const height = progress.interpolate({ inputRange: [0, 1], outputRange: [52, 64] });
  const dockWidth = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [Math.min(width - 80, 350), Math.min(width - 28, 420)],
  });
  const labelHeight = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 16] });
  const activeRoute = state.routes[state.index].name;
  const blurTarget = activeRoute === "tasks" ? blurTargets.tasks : activeRoute === "inbox" ? blurTargets.inbox : blurTargets.index;

  return (
    <Animated.View
      accessibilityLabel="Primary navigation"
      onAccessibilityTap={expand}
      style={[styles.dock, { bottom: insets.bottom + 12, height, width: dockWidth }]}
    >
      <BlurView pointerEvents="none" blurMethod="dimezisBlurView" blurTarget={blurTarget} intensity={35} tint="dark" style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={styles.tint} />
      {state.routes.map((route, index) => {
        const selected = state.index === index;
        const label = descriptors[route.key].options.title ?? route.name;
        const color = selected ? colors.headerText : colors.headerMuted;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityLabel={route.name === "inbox" && needs ? `${label}, ${needs} need you` : label}
            accessibilityState={{ selected }}
            onFocus={expand}
            onPress={() => {
              const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!selected && !event.defaultPrevented) navigation.navigate(route.name);
              else expand();
            }}
            onLongPress={() => navigation.emit({ type: "tabLongPress", target: route.key })}
            style={({ pressed }) => [styles.item, selected && styles.selected, pressed && styles.pressed]}
          >
            <View>
              <DockIcon name={route.name} color={color} />
              {route.name === "inbox" && needs ? <View style={styles.badge}><Text style={styles.badgeText}>{needs > 99 ? "99+" : needs}</Text></View> : null}
            </View>
            <Animated.View pointerEvents="none" style={[styles.labelWrap, { height: labelHeight, opacity: progress }]}>
              <Text numberOfLines={1} style={[styles.label, selected && styles.selectedLabel]}>{label}</Text>
            </Animated.View>
          </Pressable>
        );
      })}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scene: { flex: 1 },
  dock: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    zIndex: 20,
    padding: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.14)",
    borderRadius: 999,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 18,
    elevation: 12,
    overflow: "hidden",
  },
  tint: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(35, 35, 35, 0.7)" },
  item: {
    flex: 1,
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    borderRadius: 999,
  },
  selected: { backgroundColor: "rgba(55, 55, 55, 0.35)" },
  pressed: { opacity: 0.7 },
  labelWrap: { overflow: "hidden" },
  label: { color: colors.headerMuted, fontSize: 12, fontWeight: "600", lineHeight: 15, textAlign: "center" },
  selectedLabel: { color: colors.headerText, fontWeight: "700" },
  badge: {
    position: "absolute",
    top: -7,
    right: -14,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 3,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: colors.headerText,
  },
  badgeText: { color: colors.page, fontSize: 9, fontWeight: "700" },
});
