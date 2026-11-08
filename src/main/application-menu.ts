import { Menu, shell, type MenuItemConstructorOptions } from 'electron';
import log from 'electron-log/main';
import type { AppLanguage } from '../shared/language';
import { nativeMessages } from './native-messages';

const chineseLabels = new Map(
  Object.entries({
    filemenu: '文件(&F)',
    editmenu: '编辑(&E)',
    viewmenu: '视图(&V)',
    windowmenu: '窗口(&W)',
    help: '帮助(&H)',
    about: '关于 TerraCommander',
    services: '服务',
    hide: '隐藏 TerraCommander',
    hideothers: '隐藏其他应用',
    unhide: '全部显示',
    quit: '退出',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    pasteandmatchstyle: '粘贴并匹配样式',
    delete: '删除',
    selectall: '全选',
    startspeaking: '开始朗读',
    stopspeaking: '停止朗读',
    reload: '重新加载',
    forcereload: '强制重新加载',
    toggledevtools: '切换开发者工具',
    resetzoom: '实际大小',
    zoomin: '放大',
    zoomout: '缩小',
    togglefullscreen: '切换全屏',
    minimize: '最小化',
    zoom: '缩放',
    close: '关闭',
    front: '全部置于最前',
    window: '窗口',
  }),
);

function localizeMenu(menu: Menu): void {
  for (const item of menu.items) {
    const label = chineseLabels.get(item.role?.toLowerCase() ?? '');
    if (label) item.label = label;
    if (item.submenu) localizeMenu(item.submenu);
  }
}

export function setApplicationMenu(language: AppLanguage): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: nativeMessages[language].learnMore,
          click() {
            void shell.openExternal('https://electronjs.org').catch(() => {
              log.warn('Could not open the help link');
            });
          },
        },
      ],
    },
  ];
  if (process.platform === 'darwin') template.unshift({ role: 'appMenu' });
  const menu = Menu.buildFromTemplate(template);
  if (language === 'zh-CN') localizeMenu(menu);
  Menu.setApplicationMenu(menu);
}
