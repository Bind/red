import type { CanaryEvent, MirrorEventPublisher } from "../util/types";

export class NoopMirrorEventPublisher implements MirrorEventPublisher {
  async publish(_event: CanaryEvent): Promise<void> {}
}

export class WebhookMirrorEventPublisher implements MirrorEventPublisher {
  constructor(private readonly url: string) {}

  async publish(event: CanaryEvent): Promise<void> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`webhook delivery failed: ${response.status} ${body}`);
    }
  }
}
