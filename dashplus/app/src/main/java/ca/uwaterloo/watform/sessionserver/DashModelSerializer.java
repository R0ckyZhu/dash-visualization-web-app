package ca.uwaterloo.watform.sessionserver;

import ca.uwaterloo.watform.alloyast.AlloyQtEnum;
import ca.uwaterloo.watform.alloyast.expr.AlloyExpr;
import ca.uwaterloo.watform.dashast.DashParam;
import ca.uwaterloo.watform.dashast.dashref.DashRef;
import ca.uwaterloo.watform.dashmodel.DashModel;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.util.List;

public class DashModelSerializer {

    public static JsonObject serialize(DashModel dm) {
        JsonObject root = new JsonObject();
        root.addProperty("rootName", dm.rootName());
        root.add("states", serializeStates(dm));
        root.add("transitions", serializeTransitions(dm));
        root.add("events", serializeEvents(dm));
        root.add("vars", serializeVars(dm));
        root.add("buffers", serializeBuffers(dm));
        return root;
    }

    private static JsonArray serializeStates(DashModel dm) {
        JsonArray arr = new JsonArray();
        for (String sfqn : dm.allStateNames()) {
            JsonObject state = new JsonObject();
            state.addProperty("id", sfqn);

            if (dm.isLeaf(sfqn)) {
                state.addProperty("kind", "BASIC");
            } else {
                state.addProperty("kind", dm.stateKind(sfqn).name());
            }

            String parent = dm.parent(sfqn);
            if (parent != null) {
                state.addProperty("parent", parent);
            } else {
                state.add("parent", JsonNull.INSTANCE);
            }

            JsonArray children = new JsonArray();
            for (String child : dm.immChildren(sfqn)) {
                children.add(child);
            }
            state.add("children", children);

            state.addProperty("isDefault", dm.isDefault(sfqn));

            JsonArray params = serializeParams(dm.stateParams(sfqn));
            state.add("params", params);

            arr.add(state);
        }
        return arr;
    }

    private static JsonArray serializeTransitions(DashModel dm) {
        JsonArray arr = new JsonArray();
        for (String tfqn : dm.allTransNames()) {
            JsonObject trans = new JsonObject();
            trans.addProperty("id", tfqn);

            DashRef fromRef = dm.fromR(tfqn);
            trans.addProperty("from", fromRef != null ? fromRef.name : null);

            DashRef gotoRef = dm.gotoR(tfqn);
            trans.addProperty("to", gotoRef != null ? gotoRef.name : null);

            DashRef onRef = dm.onR(tfqn);
            trans.addProperty("on", onRef != null ? onRef.name : null);

            DashRef sendRef = dm.sendR(tfqn);
            trans.addProperty("send", sendRef != null ? sendRef.name : null);

            AlloyExpr whenExpr = dm.whenR(tfqn);
            trans.addProperty("when", whenExpr != null ? whenExpr.toString() : null);

            AlloyExpr doExpr = dm.doR(tfqn);
            trans.addProperty("do", doExpr != null ? doExpr.toString() : null);

            arr.add(trans);
        }
        return arr;
    }

    private static JsonArray serializeEvents(DashModel dm) {
        JsonArray arr = new JsonArray();
        for (String efqn : dm.allEventNames()) {
            JsonObject event = new JsonObject();
            event.addProperty("id", efqn);
            event.addProperty("kind", dm.eventKind(efqn).name());

            JsonArray params = serializeParams(dm.eventParams(efqn));
            event.add("params", params);

            arr.add(event);
        }
        return arr;
    }

    private static JsonArray serializeVars(DashModel dm) {
        JsonArray arr = new JsonArray();
        for (String vfqn : dm.allVarNames()) {
            JsonObject var = new JsonObject();
            var.addProperty("id", vfqn);
            var.addProperty("kind", dm.varKind(vfqn).name());

            AlloyQtEnum mul = dm.mul(vfqn);
            var.addProperty("multiplicity", mul != null ? mul.label : null);

            AlloyExpr typ = dm.varTyp(vfqn);
            var.addProperty("type", typ != null ? typ.toString() : null);

            JsonArray params = serializeParams(dm.varParams(vfqn));
            var.add("params", params);

            arr.add(var);
        }
        return arr;
    }

    private static JsonArray serializeBuffers(DashModel dm) {
        JsonArray arr = new JsonArray();
        for (String bfqn : dm.allBufferNames()) {
            JsonObject buf = new JsonObject();
            buf.addProperty("id", bfqn);
            buf.addProperty("kind", dm.bufferKind(bfqn).name());
            buf.addProperty("element", dm.bufferElement(bfqn));

            JsonArray params = serializeParams(dm.bufferParams(bfqn));
            buf.add("params", params);

            arr.add(buf);
        }
        return arr;
    }

    private static JsonArray serializeParams(List<DashParam> params) {
        JsonArray arr = new JsonArray();
        if (params != null) {
            for (DashParam p : params) {
                JsonObject param = new JsonObject();
                param.addProperty("stateName", p.stateName);
                param.addProperty("paramSig", p.paramSig);
                arr.add(param);
            }
        }
        return arr;
    }
}
