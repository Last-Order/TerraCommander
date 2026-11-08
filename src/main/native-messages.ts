import type { AppLanguage } from '../shared/language';

const en = {
  startupFailed: 'TerraCommander could not start. Check the application log.',
  rendererFailed: 'TerraCommander could not load. Restart the application.',
  chooseFolder: 'Select a folder to display',
  callbackReceived: 'Authorization response received. Return to TerraCommander.',
  callbackIncomplete: 'Authorization was not completed. Return to TerraCommander.',
  callbackDuplicate: 'This authorization response has already been received.',
  callbackInvalid: 'Invalid authorization callback.',
  learnMore: 'Learn More',
};

export const nativeMessages: Record<AppLanguage, typeof en> = {
  en,
  'zh-CN': {
    startupFailed: '应用启动失败，请查看应用日志。',
    rendererFailed: '应用加载失败，请重新启动。',
    chooseFolder: '选择要显示的文件夹',
    callbackReceived: '已收到授权响应，请返回 TerraCommander。',
    callbackIncomplete: '未完成授权，请返回 TerraCommander。',
    callbackDuplicate: '已收到过此授权响应。',
    callbackInvalid: '授权回调无效。',
    learnMore: '了解更多',
  },
};
