import {
  DecoratorNode,
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from "lexical"

export interface MentionUser {
  id: string
  name: string
  email: string
  photoLink?: string
}

export type SerializedMentionNode = Spread<
  {
    mentionUser: MentionUser
    type: "mention"
    version: 1
  },
  SerializedLexicalNode
>

export class MentionNode extends DecoratorNode<JSX.Element> {
  __mentionUser: MentionUser

  static getType(): string {
    return "mention"
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mentionUser, node.__key)
  }

  constructor(mentionUser: MentionUser, key?: NodeKey) {
    super(key)
    this.__mentionUser = mentionUser
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement("span")
    element.className =
      "mention-node inline-flex items-center px-0 py-0 mx-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-sm font-medium cursor-pointer select-all"
    element.setAttribute("data-lexical-mention", "true")
    element.setAttribute("data-lexical-decorator", "true")
    element.setAttribute("data-mention-id", this.__mentionUser.id)
    // Make the element selectable and deletable
    element.contentEditable = "false"
    element.setAttribute("draggable", "true")
    element.spellcheck = false
    return element
  }

  updateDOM(): false {
    return false
  }

  exportJSON(): SerializedMentionNode {
    return {
      mentionUser: this.__mentionUser,
      type: "mention",
      version: 1,
    }
  }

  static importJSON(serializedNode: SerializedMentionNode): MentionNode {
    const node = $createMentionNode(serializedNode.mentionUser)
    return node
  }

  decorate(): JSX.Element {
    return (
      <span
        className="mention-node inline-flex items-center px-0 py-0 mx-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-sm font-medium cursor-pointer"
        data-lexical-mention="true"
        data-mention-id={this.__mentionUser.id}
      >
        @{this.__mentionUser.name}
      </span>
    )
  }

  getMentionUser(): MentionUser {
    return this.__mentionUser
  }

  getTextContent(): string {
    return `@${this.__mentionUser.name}`
  }

  isInline(): boolean {
    return true
  }

  isIsolated(): boolean {
    return false
  }

  isKeyboardSelectable(): boolean {
    return true
  }

  canBeEmpty(): boolean {
    return false
  }

  isSegmented(): boolean {
    return true
  }

  excludeFromCopy(): boolean {
    return false
  }
}

export function $createMentionNode(mentionUser: MentionUser): MentionNode {
  return new MentionNode(mentionUser)
}

export function $isMentionNode(
  node: LexicalNode | null | undefined,
): node is MentionNode {
  return node instanceof MentionNode
}
