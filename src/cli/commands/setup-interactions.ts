import { registerApp } from '@larksuite/channel';
import qrcode from 'qrcode-terminal';
import { resolveProfileRuntime } from '../../runtime/profile-runtime';

/** Explicit, additive authorization for existing PersonalAgent card callbacks. */
export async function runSetupInteractions(opts: { profile?: string }): Promise<void> {
  const { cfg, profile } = await resolveProfileRuntime({ profile: opts.profile, allowBootstrap: false });
  const appId = cfg.accounts.app.id;
  console.log(`为 ${profile} (${appId}) 配置 card.action.trigger；保留原应用和本地凭据。`);
  const result = await registerApp({
    source: 'lark-channel-bridge',
    appId,
    addons: { preset: false, callbacks: { items: ['card.action.trigger'] } },
    onQRCodeReady: info => {
      console.log(info.url);
      qrcode.generate(info.url, { small: true });
    },
  });
  if (result.client_id !== appId) throw new Error('Configured app does not match the selected profile; local credentials were not changed');
  console.log(`✓ ${profile} 卡片回调配置已确认；请点击测试卡片验证。`);
}
