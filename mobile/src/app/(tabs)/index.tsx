import { router } from "expo-router";
import { BriefingCard } from "@/components/briefing";
import { TaskItem, ThreadItem } from "@/components/rows";
import { ConnectPrompt, StatusLine } from "@/components/status-line";
import { Button, Screen, Section, T } from "@/components/ui";
import { addDays, dublinDateKey } from "@/lib/dates";
import { openTasks, threads, whenKey } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { UpdateBanner } from "@/lib/updates";

export default function Today() {
  const { rows, connection, ready } = useStore();
  if (ready && !connection) {
    return (
      <Screen>
        <UpdateBanner />
        <ConnectPrompt />
      </Screen>
    );
  }

  const today = dublinDateKey();
  const open = openTasks(rows);
  const next = open.slice(0, 5);
  const soon = open.slice(5).filter(task => {
    const key = whenKey(rows, task);
    return key !== null && key <= addDays(today, 3);
  }).slice(0, 5);
  const needs = threads(rows).filter(thread => thread.group === "needs_you");

  return (
    <Screen>
      <UpdateBanner />
      <StatusLine />

      <Section title="Needs you" count={needs.length} />
      {needs.length ? needs.slice(0, 3).map(thread => <ThreadItem key={thread.key} thread={thread} />) : <T size="small" tone="faint">Nothing waiting</T>}
      {needs.length > 3 ? <Button label={`All ${needs.length}`} tone="quiet" onPress={() => router.push("/inbox")} /> : null}

      <BriefingCard />

      <Section title="Next up" count={open.length} />
      {next.length ? next.map(task => <TaskItem key={task.id} task={task} />) : <T size="small" tone="faint">All clear</T>}

      {soon.length ? (
        <>
          <Section title="Due soon" />
          {soon.map(task => <TaskItem key={task.id} task={task} />)}
        </>
      ) : null}
    </Screen>
  );
}
