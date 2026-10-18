import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

const UNIFORMS = `
	uniform float width;
	uniform float height;
	uniform float radius;
	uniform float inset;
`;
const MASK = `
	vec2 size = vec2(width, height);
	vec2 uv = cogl_tex_coord_in[0].st;
	vec2 halfSize = max(size * 0.5 - vec2(inset), vec2(0.0));
	float r = min(max(radius - inset, 0.0), min(halfSize.x, halfSize.y));
	vec2 q = abs(uv * size - size * 0.5) - (halfSize - vec2(r));
	float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
	float coverage = 1.0 - smoothstep(-0.75, 0.0, d);
`;

function setFloat(effect, name, value) {
	if (typeof effect.set_uniform_float === 'function') {
		effect.set_uniform_float(name, 1, [value]);
	} else {
		effect.set_uniform_value(name, value + 0.0001);
	};
};

let RoundedClip;

if (typeof Clutter.ShaderEffect.prototype.set_shader_source === 'function') {
	RoundedClip = GObject.registerClass(class RoundedClipLegacy extends Clutter.ShaderEffect {
		_init(radius, inset) {
			super._init();
			this.set_shader_source(`
				uniform sampler2D tex;
				${UNIFORMS}
				void main() {
					${MASK}
					cogl_color_out = texture2D(tex, uv) * cogl_color_in * coverage;
				}
			`);
			this.set_uniform_value('tex', 0);
			setFloat(this, 'radius', radius);
			setFloat(this, 'inset', inset);
		};
	});
} else {
	RoundedClip = GObject.registerClass(class RoundedClipSnippet extends Clutter.ShaderEffect {
		_init(radius, inset) {
			super._init();
			setFloat(this, 'radius', radius);
			setFloat(this, 'inset', inset);
		};

		vfunc_get_static_snippet() {
			return new Cogl.Snippet(Cogl.SnippetHook.FRAGMENT,
				UNIFORMS, `${MASK} cogl_color_out *= coverage;`);
		};
	});
};

export function clipRounded(actor, radius, inset = 0) {
	const effect = new RoundedClip(radius, inset);
	const update = () => {
		if (!actor.get_stage()) return;
		setFloat(effect, 'width', Math.max(1, actor.width));
		setFloat(effect, 'height', Math.max(1, actor.height));
	};
	let attached = false;
	const mappedOwner = {};
	const attach = () => {
		if (!attached && actor.get_stage()) {
			actor.add_effect_with_name('widgets-rounded-clip', effect);
			attached = true;
			update();
			actor.disconnectObject(mappedOwner);
		};
	};
	actor.connectObject('notify::mapped', attach, mappedOwner);
	actor.connectObject(
		'notify::width', update,
		'notify::height', update,
		'destroy', () => actor.disconnectObject(mappedOwner),
		actor);
	update();
	attach();
};
