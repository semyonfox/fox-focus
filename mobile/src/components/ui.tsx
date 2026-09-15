import { useState, type ReactNode } from "react";
import {
  Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from "react-native";
import type { DotTone } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { colors, font, radius, space } from "@/lib/theme";

const tones = {
  text: colors.text, strong: colors.strong, muted: colors.muted, faint: colors.faint,
  amber: colors.amber, blue: colors.blue, page: colors.page,
} as const;

export function T({ children, tone = "text", size = "body", bold = false, style, numberOfLines }: {
  children: ReactNode;
  tone?: keyof typeof tones;
  size?: keyof typeof font;
  bold?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[{ color: tones[tone], fontSize: font[size], lineHeight: Math.round(font[size] * 1.4) }, bold && styles.bold, style]}
    >
      {children}
    </Text>
  );
}

export function Screen({ children }: { children: ReactNode }) {
  const { loading, refresh } = useStore();
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.screenContent}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.muted} colors={[colors.page]} progressBackgroundColor={colors.accent} />
      }
    >
      {children}
    </ScrollView>
  );
}

export function Section({ title, count, action }: { title: string; count?: number; action?: ReactNode }) {
  return (
    <View style={styles.section}>
      <T size="tiny" tone="faint" bold style={styles.sectionTitle}>
        {title.toUpperCase()}{count !== undefined ? `  ${count}` : ""}
      </T>
      {action}
    </View>
  );
}

export function Button({ label, onPress, tone = "plain", disabled = false }: {
  label: string;
  onPress: () => void;
  tone?: "primary" | "plain" | "quiet";
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, buttonTones[tone], disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text style={[styles.buttonText, { color: tone === "primary" ? colors.page : tone === "quiet" ? colors.muted : colors.strong }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={4} style={[styles.chip, on && styles.chipOn]}>
      <T size="small" tone={on ? "page" : "muted"}>{label}</T>
    </Pressable>
  );
}

export function Checkbox({ checked, pending = false, disabled = false, onPress }: {
  checked: boolean;
  pending?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={12}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      style={[styles.check, checked && styles.checkOn, pending && styles.checkPending, disabled && !pending && styles.disabled]}
    >
      {checked ? <Text style={styles.checkMark}>✓</Text> : null}
    </Pressable>
  );
}

const dotColors: Record<DotTone, string> = { amber: colors.amber, blue: colors.blue, light: colors.accent, faint: colors.faint };

export function Dot({ tone }: { tone: DotTone }) {
  return <View style={[styles.dot, { backgroundColor: dotColors[tone] }]} />;
}

export function Panel({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

export function Field(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={colors.faint}
      selectionColor={colors.accent}
      cursorColor={colors.accent}
      {...props}
      style={[styles.field, props.multiline && styles.fieldMulti, props.style]}
    />
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <View style={styles.actions}>{children}</View>;
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <T size="small" tone="faint" style={styles.factLabel}>{label}</T>
      <T size="small" style={styles.grow}>{value}</T>
    </View>
  );
}

export function Composer({ placeholder, submitLabel = "Send", onSubmit, onCancel }: {
  placeholder: string;
  submitLabel?: string;
  onSubmit: (text: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setBusy(true);
    const ok = await onSubmit(value);
    setBusy(false);
    if (ok) setText("");
  };
  return (
    <Panel>
      <Field value={text} onChangeText={setText} placeholder={placeholder} multiline autoFocus maxLength={2000} />
      <Actions>
        <Button label={submitLabel} tone="primary" disabled={busy || !text.trim()} onPress={() => { void submit(); }} />
        {onCancel ? <Button label="Cancel" tone="quiet" onPress={onCancel} /> : null}
      </Actions>
    </Panel>
  );
}

export function Missing() {
  return (
    <View style={[styles.screen, styles.screenContent]}>
      <T tone="faint">Not found</T>
    </View>
  );
}

const buttonTones = StyleSheet.create({
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  plain: { backgroundColor: colors.accentSoft, borderColor: colors.line },
  quiet: { backgroundColor: "transparent", borderColor: colors.line },
});

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  grow: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.page },
  screenContent: { padding: space.lg, paddingBottom: 120 },
  section: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.xl, marginBottom: space.xs },
  sectionTitle: { letterSpacing: 0.8 },
  button: { borderWidth: 1, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 10 },
  buttonText: { fontSize: font.small, fontWeight: "500" },
  chip: { borderRadius: radius, borderWidth: 1, borderColor: colors.line, paddingVertical: 4, paddingHorizontal: space.md },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  check: {
    width: 22, height: 22, borderRadius: 5, borderWidth: 1.5, borderColor: colors.faint,
    alignItems: "center", justifyContent: "center",
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkPending: { borderColor: colors.amber, borderStyle: "dashed" },
  checkMark: { color: colors.page, fontSize: 14, fontWeight: "700", lineHeight: 16 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  panel: {
    backgroundColor: colors.panel, borderColor: colors.line, borderWidth: 1, borderRadius: radius,
    padding: space.md, marginTop: space.md,
  },
  field: {
    color: colors.text, fontSize: font.body, backgroundColor: colors.panelMuted, borderRadius: 6,
    paddingVertical: space.sm, paddingHorizontal: space.md, marginBottom: space.sm,
  },
  fieldMulti: { minHeight: 88, textAlignVertical: "top" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md },
  fact: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.lineSoft },
  factLabel: { width: 96 },
});
