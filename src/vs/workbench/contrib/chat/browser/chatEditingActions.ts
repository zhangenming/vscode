/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ResourceSet } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorActivation } from '../../../../platform/editor/common/editor.js';
import { IListService } from '../../../../platform/list/browser/listService.js';
import { GroupsOrder, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatAgentLocation } from '../common/chatAgents.js';
import { CONTEXT_CHAT_LOCATION, CONTEXT_CHAT_REQUEST_IN_PROGRESS, CONTEXT_ITEM_ID, CONTEXT_LAST_ITEM_ID, CONTEXT_RESPONSE } from '../common/chatContextKeys.js';
import { applyingChatEditsContextKey, CHAT_EDITING_MULTI_DIFF_SOURCE_RESOLVER_SCHEME, chatEditingResourceContextKey, chatEditingWidgetFileStateContextKey, decidedChatEditingResourceContextKey, IChatEditingService, IChatEditingSession, inChatEditingSessionContextKey, isChatRequestCheckpointed, WorkingSetEntryState } from '../common/chatEditingService.js';
import { isResponseVM } from '../common/chatViewModel.js';
import { CHAT_CATEGORY } from './actions/chatActions.js';
import { IChatWidget, IChatWidgetService } from './chat.js';

abstract class WorkingSetAction extends Action2 {
	run(accessor: ServicesAccessor, ...args: any[]) {
		const chatEditingService = accessor.get(IChatEditingService);
		const currentEditingSession = chatEditingService.currentEditingSession;
		if (!currentEditingSession) {
			return;
		}

		const chatWidget = accessor.get(IChatWidgetService).lastFocusedWidget;
		const uris: URI[] = [];
		if (URI.isUri(args[0])) {
			uris.push(args[0]);
		} else if (chatWidget) {
			uris.push(...chatWidget.input.selectedElements);
		}
		if (!uris.length) {
			return;
		}

		return this.runWorkingSetAction(accessor, currentEditingSession, chatWidget, ...uris);
	}

	abstract runWorkingSetAction(accessor: ServicesAccessor, currentEditingSession: IChatEditingSession, chatWidget: IChatWidget | undefined, ...uris: URI[]): any;
}


registerAction2(class RemoveFileFromWorkingSet extends WorkingSetAction {
	constructor() {
		super({
			id: 'chatEditing.removeFileFromWorkingSet',
			title: localize2('removeFileFromWorkingSet', 'Remove File'),
			icon: Codicon.close,
			menu: [{
				id: MenuId.ChatEditingSessionWidgetToolbar,
				// when: ContextKeyExpr.false(), // TODO@joyceerhl enable this when attachments are stored as part of the chat input
				when: ContextKeyExpr.equals(chatEditingWidgetFileStateContextKey.key, WorkingSetEntryState.Attached),
				order: 0,
				group: 'navigation'
			}],
		});
	}

	async runWorkingSetAction(accessor: ServicesAccessor, currentEditingSession: IChatEditingSession, chatWidget: IChatWidget, ...uris: URI[]): Promise<void> {
		// Remove from working set
		currentEditingSession.remove(...uris);

		// Remove from chat input part
		const resourceSet = new ResourceSet(uris);
		const newContext = [];

		for (const context of chatWidget.input.attachmentModel.attachments) {
			if (!URI.isUri(context.value) || !context.isFile || !resourceSet.has(context.value)) {
				newContext.push(context);
			}
		}

		chatWidget.attachmentModel.clearAndSetContext(...newContext);
	}
});

registerAction2(class OpenFileAction extends WorkingSetAction {
	constructor() {
		super({
			id: 'chatEditing.openFile',
			title: localize2('open.file', 'Open File'),
			icon: Codicon.goToFile,
			menu: [{
				id: MenuId.ChatEditingSessionWidgetToolbar,
				when: ContextKeyExpr.equals(chatEditingWidgetFileStateContextKey.key, WorkingSetEntryState.Modified),
				order: 0,
				group: 'navigation'
			}],
		});
	}

	async runWorkingSetAction(accessor: ServicesAccessor, currentEditingSession: IChatEditingSession, chatWidget: IChatWidget, ...uris: URI[]): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await Promise.all(uris.map((uri) => editorService.openEditor({ resource: uri, options: { pinned: true, activation: EditorActivation.ACTIVATE } })));
	}
});

registerAction2(class AcceptAction extends WorkingSetAction {
	constructor() {
		super({
			id: 'chatEditing.acceptFile',
			title: localize2('accept.file', 'Accept'),
			icon: Codicon.check,
			menu: [{
				when: ContextKeyExpr.and(ContextKeyExpr.equals('resourceScheme', CHAT_EDITING_MULTI_DIFF_SOURCE_RESOLVER_SCHEME), ContextKeyExpr.notIn(chatEditingResourceContextKey.key, decidedChatEditingResourceContextKey.key)),
				id: MenuId.MultiDiffEditorFileToolbar,
				order: 0,
				group: 'navigation',
			}, {
				id: MenuId.ChatEditingSessionWidgetToolbar,
				when: ContextKeyExpr.equals(chatEditingWidgetFileStateContextKey.key, WorkingSetEntryState.Modified),
				order: 2,
				group: 'navigation'
			}],
		});
	}

	async runWorkingSetAction(accessor: ServicesAccessor, currentEditingSession: IChatEditingSession, chatWidget: IChatWidget, ...uris: URI[]): Promise<void> {
		await currentEditingSession.accept(...uris);
	}
});

registerAction2(class DiscardAction extends WorkingSetAction {
	constructor() {
		super({
			id: 'chatEditing.discardFile',
			title: localize2('discard.file', 'Discard'),
			icon: Codicon.discard,
			menu: [{
				when: ContextKeyExpr.and(ContextKeyExpr.equals('resourceScheme', CHAT_EDITING_MULTI_DIFF_SOURCE_RESOLVER_SCHEME), ContextKeyExpr.notIn(chatEditingResourceContextKey.key, decidedChatEditingResourceContextKey.key)),
				id: MenuId.MultiDiffEditorFileToolbar,
				order: 0,
				group: 'navigation',
			}, {
				id: MenuId.ChatEditingSessionWidgetToolbar,
				when: ContextKeyExpr.equals(chatEditingWidgetFileStateContextKey.key, WorkingSetEntryState.Modified),
				order: 1,
				group: 'navigation'
			}],
		});
	}

	async runWorkingSetAction(accessor: ServicesAccessor, currentEditingSession: IChatEditingSession, chatWidget: IChatWidget, ...uris: URI[]): Promise<void> {
		await currentEditingSession.reject(...uris);
	}
});

export class ChatEditingAcceptAllAction extends Action2 {
	static readonly ID = 'chatEditing.acceptAllFiles';
	static readonly LABEL = localize('accept.allFiles', 'Accept All');

	constructor() {
		super({
			id: ChatEditingAcceptAllAction.ID,
			title: ChatEditingAcceptAllAction.LABEL,
			// icon: Codicon.goToFile,
			menu: {
				when: ContextKeyExpr.equals('resourceScheme', CHAT_EDITING_MULTI_DIFF_SOURCE_RESOLVER_SCHEME),
				id: MenuId.EditorTitle,
				order: 0,
				group: 'navigation',
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const chatEditingService = accessor.get(IChatEditingService);
		const currentEditingSession = chatEditingService.currentEditingSession;
		if (!currentEditingSession) {
			return;
		}
		await currentEditingSession.accept();
	}
}
registerAction2(ChatEditingAcceptAllAction);

export class ChatEditingDiscardAllAction extends Action2 {
	static readonly ID = 'chatEditing.discardAllFiles';
	static readonly LABEL = localize('discard.allFiles', 'Discard All');

	constructor() {
		super({
			id: ChatEditingDiscardAllAction.ID,
			title: ChatEditingDiscardAllAction.LABEL,
			// icon: Codicon.goToFile,
			menu: {
				when: ContextKeyExpr.equals('resourceScheme', CHAT_EDITING_MULTI_DIFF_SOURCE_RESOLVER_SCHEME),
				id: MenuId.EditorTitle,
				order: 0,
				group: 'navigation',
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const chatEditingService = accessor.get(IChatEditingService);
		const currentEditingSession = chatEditingService.currentEditingSession;
		if (!currentEditingSession) {
			return;
		}
		await currentEditingSession.reject();
	}
}
registerAction2(ChatEditingDiscardAllAction);

export class ChatEditingShowChangesAction extends Action2 {
	static readonly ID = 'chatEditing.openDiffs';
	static readonly LABEL = localize('chatEditing.openDiffs', 'Open Diffs');

	constructor() {
		super({
			id: ChatEditingShowChangesAction.ID,
			title: ChatEditingShowChangesAction.LABEL,
			f1: false
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const chatEditingService = accessor.get(IChatEditingService);
		const currentEditingSession = chatEditingService.currentEditingSession;
		if (!currentEditingSession) {
			return;
		}
		await currentEditingSession.show();
	}
}
registerAction2(ChatEditingShowChangesAction);

registerAction2(class AddFilesToWorkingSetAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.addFilesToWorkingSet',
			title: localize2('workbench.action.chat.addFilesToWorkingSet.label', "Add Files to Working Set"),
			icon: Codicon.attach,
			category: CHAT_CATEGORY,
			precondition: inChatEditingSessionContextKey,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const listService = accessor.get(IListService);
		const chatEditingService = accessor.get(IChatEditingService);
		const editorGroupService = accessor.get(IEditorGroupsService);

		const uris: URI[] = [];

		for (const group of editorGroupService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
			for (const selection of group.selectedEditors) {
				if (selection.resource) {
					uris.push(selection.resource);
				}
			}
		}

		if (uris.length === 0) {
			const selection = listService.lastFocusedList?.getSelection();
			if (selection?.length) {
				for (const file of selection) {
					if (!!file && typeof file === 'object' && 'resource' in file && URI.isUri(file.resource)) {
						uris.push(file.resource);
					}
				}
			}
		}

		for (const file of uris) {
			await chatEditingService?.addFileToWorkingSet(file);
		}
	}
});


registerAction2(class RestoreWorkingSetAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.restoreWorkingSet',
			title: localize2('chat.restoreWorkingSet.label', 'Restore Working Set'),
			f1: false,
			shortTitle: localize2('chat.restoreWorkingSet.shortTitle', 'Restore Working Set'),
			toggled: {
				condition: isChatRequestCheckpointed,
				title: localize2('chat.restoreWorkingSet.title', 'Using Working Set').value,
				tooltip: localize2('chat.restoreWorkingSet.tooltip', 'Toggle to use the working set state from an earlier request in your next edit').value
			},
			precondition: ContextKeyExpr.and(applyingChatEditsContextKey.negate(), CONTEXT_CHAT_REQUEST_IN_PROGRESS.negate()),
			menu: {
				id: MenuId.ChatMessageFooter,
				group: 'navigation',
				order: 1000,
				when: ContextKeyExpr.and(
					CONTEXT_CHAT_LOCATION.isEqualTo(ChatAgentLocation.EditingSession),
					CONTEXT_RESPONSE,
					ContextKeyExpr.notIn(CONTEXT_ITEM_ID.key, CONTEXT_LAST_ITEM_ID.key)
				)
			}
		});
	}

	override run(accessor: ServicesAccessor, ...args: any[]): void {
		const item = args[0];
		if (!isResponseVM(item)) {
			return;
		}

		const { session, requestId } = item.model;
		if (requestId === session.checkpoint?.id) {
			// Unset the existing checkpoint
			session.setCheckpoint(undefined);
		} else {
			session.setCheckpoint(requestId);
		}
	}
});
