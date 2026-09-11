self.addEventListener("push", (event) => {
  let message;
  try {
    message = event.data?.json();
  } catch {
    return;
  }
  if (!message || typeof message.title !== "string") return;
  event.waitUntil(self.registration.showNotification(message.title, {
    body: typeof message.body === "string" ? message.body : "",
    tag: typeof message.tag === "string" ? message.tag : undefined,
    data: { url: typeof message.url === "string" ? message.url : "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    return existing ? existing.focus() : clients.openWindow(target);
  }));
});
