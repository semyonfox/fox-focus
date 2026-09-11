declare module 'web-push' {
  export type PushSubscription = {
    endpoint: string;
    expirationTime?: number | null;
    keys: { p256dh: string; auth: string };
  };

  export type WebPushError = Error & { statusCode?: number };

  const webPush: {
    generateVAPIDKeys(): { publicKey: string; privateKey: string };
    setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
    sendNotification(subscription: PushSubscription, payload?: string): Promise<unknown>;
  };

  export default webPush;
}
