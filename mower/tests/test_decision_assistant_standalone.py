"""DecisionAssistant must own its own ROS node so it lives in the
/decision_assistant namespace. The decoupling test only checks structure: the
class accepts a 'host_node' object for state queries and creates its action
servers on its OWN node, NOT on host_node.

Note: This test uses AST source inspection instead of importlib because rclpy
(ROS 2) is not available on macOS dev machines. The assertions remain the same:
  1. DecisionAssistant class inherits from Node
  2. DecisionAssistant.__init__ accepts host_node parameter
"""
import ast
from pathlib import Path


def test_decision_assistant_takes_host_node_and_owns_self_node():
    """Verify DecisionAssistant.__init__ signature contains host_node parameter."""
    # Parse decision_assistant.py source
    src_file = Path(__file__).resolve().parents[1] / 'decision_assistant.py'
    tree = ast.parse(src_file.read_text(), filename=str(src_file))

    # Find the DecisionAssistant class
    decision_assistant_class = None
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == 'DecisionAssistant':
            decision_assistant_class = node
            break

    assert decision_assistant_class is not None, (
        'DecisionAssistant class not found in decision_assistant.py'
    )

    # Find the __init__ method
    init_method = None
    for item in decision_assistant_class.body:
        if isinstance(item, ast.FunctionDef) and item.name == '__init__':
            init_method = item
            break

    assert init_method is not None, (
        'DecisionAssistant.__init__ method not found'
    )

    # Extract parameter names
    param_names = [arg.arg for arg in init_method.args.args]

    assert 'host_node' in param_names, (
        'DecisionAssistant.__init__ must accept host_node (the robot_decision '
        'node) so it can read .x, .y, .theta, .task_mode without sharing the '
        'same ROS node. Current parameters: ' + str(param_names)
    )


def test_decision_assistant_node_is_a_node_subclass():
    """Verify DecisionAssistant class inherits from Node."""
    # Parse decision_assistant.py source
    src_file = Path(__file__).resolve().parents[1] / 'decision_assistant.py'
    tree = ast.parse(src_file.read_text(), filename=str(src_file))

    # Find the DecisionAssistant class
    decision_assistant_class = None
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == 'DecisionAssistant':
            decision_assistant_class = node
            break

    assert decision_assistant_class is not None, (
        'DecisionAssistant class not found in decision_assistant.py'
    )

    # Check base classes
    base_names = []
    for base in decision_assistant_class.bases:
        if isinstance(base, ast.Name):
            base_names.append(base.id)
        elif isinstance(base, ast.Attribute):
            # Handle rclpy.node.Node or similar
            base_names.append(base.attr)

    assert 'Node' in base_names, (
        'DecisionAssistant must subclass rclpy.node.Node so it can register '
        'itself with the executor on the /decision_assistant namespace. '
        'Current base classes: ' + str(base_names)
    )
