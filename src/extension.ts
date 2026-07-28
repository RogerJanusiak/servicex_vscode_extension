import * as vscode from 'vscode';
import { CacheTreeProvider } from './cacheTreeProvider';

export function activate(context: vscode.ExtensionContext) {
  const cacheTreeProvider = new CacheTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('servicexCacheView', cacheTreeProvider)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.refreshCache', () => cacheTreeProvider.refresh())
  );
}

export function deactivate() {}
