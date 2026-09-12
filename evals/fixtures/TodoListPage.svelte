<script lang="ts">
	import StaticSurface from '../../src/lib/renderer/StaticSurface.svelte';
	import Column from '../../src/lib/components/Column.svelte';
	import Row from '../../src/lib/components/Row.svelte';
	import Text from '../../src/lib/components/Text.svelte';
	import TextField from '../../src/lib/components/TextField.svelte';
	import Checkbox from '../../src/lib/components/Checkbox.svelte';
	import Button from '../../src/lib/components/Button.svelte';
	import Divider from '../../src/lib/components/Divider.svelte';
	import { todoContext } from './todo-list-agent';

	/**
	 * Dense, realistic eval fixture: a todo list. One row per task with a done
	 * CheckBox and five TextField detail cells (`todo-<slug>-<field>`), an
	 * add-task form whose submission APPENDS a row (a structural change the
	 * model can only learn from a surface echo / sync), and a save button.
	 *
	 * `todoCount` scales the surface for verbosity measurements: the first six
	 * tasks are a fixed seed (so eval questions have stable answers); higher
	 * counts append generated tasks.
	 */
	interface Props {
		surfaceId?: string;
		todoCount?: number;
	}

	let { surfaceId = 'todo-list', todoCount = 6 }: Props = $props();

	const FIELDS = ['due', 'priority', 'assignee', 'estimate', 'notes'] as const;
	const FIELD_LABELS: Record<string, string> = {
		due: 'due date',
		priority: 'priority',
		assignee: 'assignee',
		estimate: 'estimate',
		notes: 'notes'
	};

	interface Todo {
		slug: string;
		title: string;
		tag: string;
		done: boolean;
		fields: Record<string, string>;
	}

	function withAllFields(partial: Record<string, string>): Record<string, string> {
		const fields: Record<string, string> = {};
		for (const f of FIELDS) fields[f] = partial[f] ?? '';
		return fields;
	}

	function makeTodo(title: string, tag: string, fields: Record<string, string> = {}): Todo {
		return {
			slug: title.toLowerCase().replace(/\s+/g, '-'),
			title,
			tag,
			done: false,
			fields: withAllFields(fields)
		};
	}

	const SEED: Todo[] = [
		makeTodo('Invoices', 'Finance', {
			due: '2026-04-10',
			priority: 'High',
			assignee: 'Ada',
			estimate: '1h'
		}),
		makeTodo('Standup', 'Work', { due: '2026-04-06', priority: 'Medium', assignee: 'Ada' }),
		makeTodo('Laundry', 'Home', { priority: 'Low', assignee: 'Ivan' }),
		makeTodo('Taxes', 'Finance', { due: '2026-04-30', priority: 'High', assignee: 'Lena' }),
		makeTodo('Dentist', 'Health', { due: '2026-04-22', priority: 'Medium', assignee: 'Lena' }),
		makeTodo('Gym', 'Health', { priority: 'Low', assignee: 'Ivan' })
	];

	function seedTodos(count: number): Todo[] {
		const out = SEED.slice(0, Math.min(count, SEED.length));
		for (let i = SEED.length; i < count; i++) {
			out.push(makeTodo(`Task${i + 1}`, i % 2 === 0 ? 'Work' : 'Home'));
		}
		return out;
	}

	let todos = $state<Todo[]>(seedTodos(todoCount));
	let newTitle = $state('');
	let newTag = $state('');
	let lastSavedAt = $state('');

	function contextText(): string {
		return (
			'Todo List. The list has one row per task; each task has a done CheckBox with id ' +
			'"todo-<title lowercase>-done" and five TextField detail cells with id ' +
			'"todo-<title lowercase>-<field>" (fields: due, priority, assignee, estimate, notes). ' +
			'Due dates are ISO (2026-04-10), priority is High / Medium / Low, an empty cell means ' +
			'unset. To add a task, fill "add-todo-title" and "add-todo-tag", then click ' +
			'"add-todo-btn" — the form clears and a new task row appears. ' +
			'Click "save-list-btn" to persist the list.' +
			(lastSavedAt ? ` List last saved at ${lastSavedAt}.` : ' The list has not been saved yet.')
		);
	}

	function addTodo() {
		const title = newTitle.trim();
		if (!title) return;
		todos = [...todos, makeTodo(title, newTag.trim() || 'Inbox')];
		newTitle = '';
		newTag = '';
	}

	// Publish the page context for the agent definition to read — the same
	// page-publishes/definition-reads split a consumer app uses. Installed here
	// rather than in an `$effect` so it is live before the first `agent.start()`.
	// The eval itself needs no accessor: it reads the surface from the library's
	// index (`surface('todo-list')`) and the list from the DOM.
	todoContext.read = contextText;
</script>

<StaticSurface {surfaceId}>
	<Column>
		<Text id="list-title" text="Todo List" usageHint="h2" />
		<Text
			id="list-help"
			text="Your tasks. One row per task; one cell per detail."
			usageHint="caption"
		/>
		<Divider id="list-divider" />

		{#each todos as todo (todo.slug)}
			<Row>
				<Text id={`title-${todo.slug}`} text={todo.title} usageHint="body" />
				<Text id={`tag-${todo.slug}`} text={todo.tag} usageHint="caption" />
				<Checkbox
					id={`todo-${todo.slug}-done`}
					label={`${todo.title} done`}
					bind:checked={todo.done}
				/>
				{#each FIELDS as field (field)}
					<TextField
						id={`todo-${todo.slug}-${field}`}
						label={`${todo.title} ${FIELD_LABELS[field]}`}
						bind:value={todo.fields[field]}
					/>
				{/each}
			</Row>
		{/each}

		<Divider id="form-divider" />
		<Text id="add-todo-title-label" text="Add task" usageHint="h3" />
		<Row>
			<TextField id="add-todo-title" label="Title" bind:value={newTitle} />
			<TextField id="add-todo-tag" label="Tag" bind:value={newTag} />
			<Button id="add-todo-btn" label="Add task" onclick={addTodo} />
		</Row>

		<Divider id="actions-divider" />
		<Button
			id="save-list-btn"
			primary
			label="Save list"
			onclick={() => {
				lastSavedAt = new Date().toISOString();
			}}
		/>
	</Column>
</StaticSurface>
