/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { tail } from 'vs/base/common/arrays';
import { DenseKeyProvider, SmallImmutableSet } from './smallImmutableSet';
import { lengthAdd, lengthZero, Length, lengthHash } from './length';

export const enum AstNodeKind {
	Text = 0,
	Bracket = 1,
	Pair = 2,
	UnexpectedClosingBracket = 3,
	List = 4,
}

export type AstNode = PairAstNode | ListAstNode | BracketAstNode | InvalidBracketAstNode | TextAstNode;

abstract class BaseAstNode {
	abstract readonly kind: AstNodeKind;

	abstract readonly childrenLength: number;
	abstract getChild(idx: number): AstNode | null;
	/**
	 * Try to avoid using this property, as implementations might allocate.
	*/
	abstract readonly children: readonly AstNode[];
	abstract readonly unopenedBrackets: SmallImmutableSet<number>;

	/**
	 * In case of a list, determines the height of the (2,3) tree.
	*/
	abstract readonly listHeight: number;

	protected _length: Length;

	get length(): Length {
		return this._length;
	}

	constructor(length: Length) {
		this._length = length;
	}

	abstract canBeReused(
		expectedClosingCategories: SmallImmutableSet<number>,
		endLineDidChange: boolean
	): boolean;

	/**
	 * Flattenes all lists in this AST. Only for debugging.
	 */
	abstract flattenLists(): AstNode;

	/**
	 * Creates a deep clone.
	 */
	abstract deepClone(): AstNode;

	toMutable(): AstNode {
		return this as AstNode;
	}
}

/**
 * Immutable, if all children are immutable.
*/
export class PairAstNode extends BaseAstNode {
	public static create(
		category: number,
		openingBracket: BracketAstNode,
		child: AstNode | null,
		closingBracket: BracketAstNode | null
	) {
		const length = computeLength(openingBracket, child, closingBracket);
		return new PairAstNode(length, category, openingBracket, child, closingBracket, child ? child.unopenedBrackets : SmallImmutableSet.getEmpty());
	}

	get kind(): AstNodeKind.Pair {
		return AstNodeKind.Pair;
	}
	get listHeight() {
		return 0;
	}
	get childrenLength(): number {
		return 3;
	}
	getChild(idx: number): AstNode | null {
		switch (idx) {
			case 0: return this.openingBracket;
			case 1: return this.child;
			case 2: return this.closingBracket;
		}
		throw new Error('Invalid child index');
	}

	/**
	 * Avoid using this property, it allocates an array!
	*/
	get children() {
		const result = new Array<AstNode>();
		result.push(this.openingBracket);
		if (this.child) {
			result.push(this.child);
		}
		if (this.closingBracket) {
			result.push(this.closingBracket);
		}
		return result;
	}

	private constructor(
		length: Length,
		public readonly category: number,
		public readonly openingBracket: BracketAstNode,
		public readonly child: AstNode | null,
		public readonly closingBracket: BracketAstNode | null,
		public readonly unopenedBrackets: SmallImmutableSet<number>
	) {
		super(length);
	}

	canBeReused(
		expectedClosingCategories: SmallImmutableSet<number>,
		endLineDidChange: boolean
	) {
		if (this.closingBracket === null) {
			// Unclosed pair ast nodes only
			// end at the end of the document
			// or when a parent node is closed.

			// This could be improved:
			// Only return false if some next token is neither "undefined" nor a bracket that closes a parent.

			return false;
		}

		if (expectedClosingCategories.intersects(this.unopenedBrackets)) {
			return false;
		}

		return true;
	}

	flattenLists(): PairAstNode {
		return PairAstNode.create(
			this.category,
			this.openingBracket.flattenLists(),
			this.child && this.child.flattenLists(),
			this.closingBracket && this.closingBracket.flattenLists()
		);
	}

	deepClone(): PairAstNode {
		return new PairAstNode(
			this.length,
			this.category,
			this.openingBracket.deepClone(),
			this.child && this.child.deepClone(),
			this.closingBracket && this.closingBracket.deepClone(),
			this.unopenedBrackets
		);
	}
}

function computeLength(openingBracket: BracketAstNode, child: AstNode | null, closingBracket: BracketAstNode | null): Length {
	let length = openingBracket.length;
	if (child) {
		length = lengthAdd(length, child.length);
	}
	if (closingBracket) {
		length = lengthAdd(length, closingBracket.length);
	}
	return length;
}

/**
 * Mutable.
*/
export class ListAstNode extends BaseAstNode {
	public static create(items: AstNode[], immutable: boolean = false): ListAstNode {
		if (items.length === 0) {
			if (immutable) {
				return new ImmutableListAstNode(lengthZero, 0, items, SmallImmutableSet.getEmpty());
			} else {
				return new ListAstNode(lengthZero, 0, items, SmallImmutableSet.getEmpty());
			}
		} else {
			let length = items[0].length;
			let unopenedBrackets = items[0].unopenedBrackets;
			for (let i = 1; i < items.length; i++) {
				length = lengthAdd(length, items[i].length);
				unopenedBrackets = unopenedBrackets.merge(items[i].unopenedBrackets);
			}
			if (immutable) {
				return new ImmutableListAstNode(length, items[0].listHeight + 1, items, unopenedBrackets);
			} else {
				return new ListAstNode(length, items[0].listHeight + 1, items, unopenedBrackets);
			}
		}
	}

	get kind(): AstNodeKind.List {
		return AstNodeKind.List;
	}
	get childrenLength(): number {
		return this._children.length;
	}
	getChild(idx: number): AstNode | null {
		return this._children[idx];
	}
	get children(): readonly AstNode[] {
		return this._children;
	}
	get childrenFast(): readonly AstNode[] {
		return this._children;
	}
	get unopenedBrackets(): SmallImmutableSet<number> {
		return this._unopenedBrackets;
	}

	/**
	 * Use ListAstNode.create.
	*/
	constructor(
		length: Length,
		public readonly listHeight: number,
		private readonly _children: AstNode[],
		private _unopenedBrackets: SmallImmutableSet<number>
	) {
		super(length);
	}

	protected throwIfImmutable(): void {
		// NOOP
	}

	makeLastElementMutable(): AstNode | undefined {
		this.throwIfImmutable();
		if (this._children.length === 0) {
			return undefined;
		}
		const lastChild = this._children[this._children.length - 1];
		const mutable = lastChild.toMutable();
		if (lastChild !== mutable) {
			this._children[this._children.length - 1] = mutable;
		}
		return mutable;
	}

	makeFirstElementMutable(): AstNode | undefined {
		this.throwIfImmutable();
		if (this._children.length === 0) {
			return undefined;
		}
		const lastChild = this._children[0];
		const mutable = lastChild.toMutable();
		if (lastChild !== mutable) {
			this._children[0] = mutable;
		}
		return mutable;
	}

	canBeReused(
		expectedClosingCategories: SmallImmutableSet<number>,
		endLineDidChange: boolean
	): boolean {
		if (this._children.length === 0) {
			// might not be very helpful
			return true;
		}

		if (expectedClosingCategories.intersects(this.unopenedBrackets)) {
			return false;
		}

		let lastChild: ListAstNode = this;
		while (lastChild.kind === AstNodeKind.List && lastChild.childrenFast.length > 0) {
			lastChild = tail(lastChild.childrenFast) as ListAstNode;
		}

		return lastChild.canBeReused(
			expectedClosingCategories,
			endLineDidChange
		);
	}

	flattenLists(): ListAstNode {
		const items = new Array<AstNode>();
		for (const c of this.childrenFast) {
			const normalized = c.flattenLists();
			if (normalized.kind === AstNodeKind.List) {
				items.push(...normalized._children);
			} else {
				items.push(normalized);
			}
		}
		return ListAstNode.create(items);
	}

	deepClone(): ListAstNode {
		return new ListAstNode(this.length, this.listHeight, clone(this._children), this.unopenedBrackets);
	}

	public handleChildrenChanged(): void {
		this.throwIfImmutable();
		const items = this._children;
		if (items.length === 0) {
			return;
		}
		let length = items[0].length;
		let unopenedBrackets = items[0].unopenedBrackets;
		for (let i = 1; i < items.length; i++) {
			length = lengthAdd(length, items[i].length);
			unopenedBrackets = unopenedBrackets.merge(items[i].unopenedBrackets);
		}
		this._length = length;
		this._unopenedBrackets = unopenedBrackets;
	}

	public appendChildOfSameHeight(node: AstNode): void {
		this.throwIfImmutable();
		this._children.push(node);
		this.handleChildrenChanged();
	}

	public unappendChild(): AstNode | undefined {
		this.throwIfImmutable();
		const item = this._children.pop();
		this.handleChildrenChanged();
		return item;
	}

	public prependChildOfSameHeight(node: AstNode): void {
		this.throwIfImmutable();
		this._children.unshift(node);
		this.handleChildrenChanged();
	}

	public unprependChild(): AstNode | undefined {
		this.throwIfImmutable();
		const item = this._children.shift();
		this.handleChildrenChanged();
		return item;
	}
}

/**
 * Immutable, if all children are immutable.
*/
class ImmutableListAstNode extends ListAstNode {
	override toMutable(): ListAstNode {
		return new ListAstNode(this.length, this.listHeight, [...this.childrenFast], this.unopenedBrackets);
	}

	protected override throwIfImmutable(): void {
		throw new Error('this instance is immutable');
	}
}

function clone(arr: readonly AstNode[]): AstNode[] {
	const result = new Array<AstNode>(arr.length);
	for (let i = 0; i < arr.length; i++) {
		result[i] = arr[i].deepClone();
	}
	return result;
}

const emptyArray: readonly AstNode[] = [];

abstract class ImmutableLeafAstNode extends BaseAstNode {
	get listHeight() {
		return 0;
	}
	get childrenLength(): number {
		return 0;
	}
	getChild(idx: number): AstNode | null {
		return null;
	}
	get children(): readonly AstNode[] {
		return emptyArray;
	}

	flattenLists(): this & AstNode {
		return this as this & AstNode;
	}
	deepClone(): this & AstNode {
		return this as this & AstNode;
	}
}

export class TextAstNode extends ImmutableLeafAstNode {
	get kind(): AstNodeKind.Text {
		return AstNodeKind.Text;
	}
	get unopenedBrackets(): SmallImmutableSet<number> {
		return SmallImmutableSet.getEmpty();
	}

	canBeReused(
		expectedClosingCategories: SmallImmutableSet<number>,
		endLineDidChange: boolean
	) {
		// Don't reuse text from a line that got changed.
		// Otherwise, long brackes might not be detected.
		return !endLineDidChange;
	}
}

export class BracketAstNode extends ImmutableLeafAstNode {
	private static cacheByLength = new Map<number, BracketAstNode>();

	public static create(length: Length): BracketAstNode {
		const lengthKey = lengthHash(length);
		const cached = BracketAstNode.cacheByLength.get(lengthKey);
		if (cached) {
			return cached;
		}

		const node = new BracketAstNode(length);
		BracketAstNode.cacheByLength.set(lengthKey, node);
		return node;
	}

	get kind(): AstNodeKind.Bracket {
		return AstNodeKind.Bracket;
	}

	get unopenedBrackets(): SmallImmutableSet<number> {
		return SmallImmutableSet.getEmpty();
	}

	private constructor(length: Length) {
		super(length);
	}

	canBeReused(
		expectedClosingCategories: SmallImmutableSet<number>,
		endLineDidChange: boolean
	) {
		// These nodes could be reused,
		// but not in a general way.
		// Their parent may be reused.
		return false;
	}
}

export class InvalidBracketAstNode extends ImmutableLeafAstNode {
	get kind(): AstNodeKind.UnexpectedClosingBracket {
		return AstNodeKind.UnexpectedClosingBracket;
	}

	public readonly unopenedBrackets: SmallImmutableSet<number>;

	constructor(category: number, length: Length, denseKeyProvider: DenseKeyProvider<number>) {
		super(length);
		this.unopenedBrackets = SmallImmutableSet.getEmpty().add(category, denseKeyProvider);
	}

	canBeReused(
		expectedClosingCategories: SmallImmutableSet<number>,
		endLineDidChange: boolean
	) {
		return !expectedClosingCategories.intersects(this.unopenedBrackets);
	}
}
