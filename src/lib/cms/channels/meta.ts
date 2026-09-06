import type { MetaProviderConfig } from './providerSettings';

const GRAPH_VERSION = 'v26.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface MetaPhoneNumber {
  id: string;
  displayPhoneNumber: string;
}

export type MetaResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; auth: boolean };

export async function exchangeMetaCode(
  config: MetaProviderConfig,
  code: string,
): Promise<MetaResult<string>> {
  try {
    const url = new URL(`${GRAPH}/oauth/access_token`);
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('client_secret', config.appSecret);
    url.searchParams.set('code', code);
    const response = await fetch(url);
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      error?: { message?: string };
    };
    if (!response.ok || !body.access_token) {
      return {
        ok: false,
        auth: response.status >= 400 && response.status < 500,
        error: body.error?.message?.slice(0, 300) || `Meta token exchange ${response.status}`,
      };
    }
    return { ok: true, value: body.access_token };
  } catch (error) {
    return { ok: false, auth: false, error: `Meta could not be reached: ${String(error)}` };
  }
}

export async function metaPhoneNumber(
  accessToken: string,
  wabaId: string,
  preferredPhoneNumberId?: string | null,
): Promise<MetaResult<MetaPhoneNumber>> {
  try {
    const response = await fetch(`${GRAPH}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json().catch(() => ({}))) as {
      data?: { id?: string; display_phone_number?: string }[];
      error?: { message?: string };
    };
    if (!response.ok) {
      return {
        ok: false,
        auth: response.status === 401 || response.status === 403,
        error: body.error?.message?.slice(0, 300) || `Meta phone lookup ${response.status}`,
      };
    }
    const rows = body.data ?? [];
    const selected = preferredPhoneNumberId
      ? rows.find((row) => row.id === preferredPhoneNumberId) ?? rows[0]
      : rows[0];
    const id = selected?.id?.trim() ?? '';
    const displayPhoneNumber = selected?.display_phone_number?.trim() ?? '';
    if (!id || !displayPhoneNumber) {
      return { ok: false, auth: false, error: 'Meta did not return the connected WhatsApp number.' };
    }
    return { ok: true, value: { id, displayPhoneNumber } };
  } catch (error) {
    return { ok: false, auth: false, error: `Meta phone lookup failed: ${String(error)}` };
  }
}

export async function subscribeMetaApp(
  accessToken: string,
  wabaId: string,
): Promise<MetaResult<true>> {
  try {
    const response = await fetch(`${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      error?: { message?: string };
    };
    if (!response.ok || body.success === false) {
      return {
        ok: false,
        auth: response.status === 401 || response.status === 403,
        error: body.error?.message?.slice(0, 300) || `Meta webhook subscription ${response.status}`,
      };
    }
    return { ok: true, value: true };
  } catch (error) {
    return { ok: false, auth: false, error: `Meta subscription failed: ${String(error)}` };
  }
}
