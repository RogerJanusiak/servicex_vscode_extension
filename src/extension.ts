import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('servicex.helloWorld', () => {
    vscode.window.showInformationMessage('Hello from the ServiceX extension!');
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
